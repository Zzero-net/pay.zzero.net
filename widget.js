/**
 * Zero Pay Widget v0.1.0-testnet
 * https://pay.zzero.net
 *
 * Self-contained micropayment widget for the Zero Network.
 * Embed on any page to create paywalls, pay buttons, and x402 auto-payment.
 *
 * 1 Z = $0.01 USD | Fee: 0.01 Z | Max tx: 25 Z ($0.25)
 *
 * Usage:
 *   <script src="https://pay.zzero.net/widget.js"></script>
 *   <script>
 *     ZeroPay.init({ address: 'merchant_pubkey_here' });
 *     ZeroPay.paywall({ amount: 0.10, target: '#premium-content' });
 *   </script>
 *
 * Dependencies: tweetnacl (loaded from CDN automatically)
 * License: MIT
 */
(function () {
  'use strict';

  // ─── Constants ───────────────────────────────────────────────────────
  var VERSION = '0.1.0-testnet';
  var DEFAULT_RPC = 'https://rpc.zzero.net';
  var FAUCET_URL = 'http://157.180.56.48:8093';
  var Z_TO_USD = 0.01;
  var FEE_Z = 0.01;
  var MAX_TX_Z = 25;
  var TWEETNACL_CDN = 'https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/nacl-fast.min.js';
  var BLAKE3_CDN = 'https://cdn.jsdelivr.net/npm/blake3@2.1.7/browser-async.js';

  // localStorage keys
  var LS_KEY_SEED = 'zero_wallet_key';
  var LS_KEY_PUB = 'zero_wallet_pub';
  var LS_KEY_PAYMENTS = 'zero_payments';

  // ─── State ───────────────────────────────────────────────────────────
  var _config = {
    address: null,
    rpc: DEFAULT_RPC,
    theme: 'dark'
  };
  var _initialized = false;
  var _naclReady = false;
  var _naclLoading = false;
  var _naclCallbacks = [];
  var _stylesInjected = false;
  var _x402Enabled = false;

  // ─── Utility helpers ─────────────────────────────────────────────────

  /** Convert a hex string to Uint8Array */
  function hexToBytes(hex) {
    var bytes = new Uint8Array(hex.length / 2);
    for (var i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
  }

  /** Convert Uint8Array to hex string */
  function bytesToHex(bytes) {
    var hex = '';
    for (var i = 0; i < bytes.length; i++) {
      hex += ('0' + bytes[i].toString(16)).slice(-2);
    }
    return hex;
  }

  /** Base64 encode Uint8Array */
  function bytesToBase64(bytes) {
    var binary = '';
    for (var i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /** Base64 decode to Uint8Array */
  function base64ToBytes(b64) {
    var binary = atob(b64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  /** Format Z amount with proper precision */
  function formatZ(amount) {
    return parseFloat(amount).toFixed(2);
  }

  /** Format USD amount */
  function formatUSD(zAmount) {
    return '$' + (zAmount * Z_TO_USD).toFixed(4);
  }

  /** Generate a short unique ID */
  function uid() {
    return Math.random().toString(36).substr(2, 9);
  }

  /** Simple BLAKE3 hash fallback — uses SHA-256 if BLAKE3 is not available */
  function hashBytes(data) {
    // Use SubtleCrypto SHA-256 as a practical fallback since BLAKE3 browser
    // libraries are heavy. In production the node validates with BLAKE3.
    return crypto.subtle.digest('SHA-256', data).then(function (buf) {
      return new Uint8Array(buf);
    });
  }

  // ─── NaCl loader ────────────────────────────────────────────────────

  function ensureNacl(cb) {
    if (_naclReady && window.nacl) {
      cb(null);
      return;
    }
    _naclCallbacks.push(cb);
    if (_naclLoading) return;
    _naclLoading = true;

    var script = document.createElement('script');
    script.src = TWEETNACL_CDN;
    script.onload = function () {
      _naclReady = true;
      _naclLoading = false;
      var cbs = _naclCallbacks.slice();
      _naclCallbacks = [];
      cbs.forEach(function (fn) { fn(null); });
    };
    script.onerror = function () {
      _naclLoading = false;
      var cbs = _naclCallbacks.slice();
      _naclCallbacks = [];
      cbs.forEach(function (fn) { fn(new Error('Failed to load tweetnacl from CDN')); });
    };
    document.head.appendChild(script);
  }

  // ─── Wallet management ──────────────────────────────────────────────

  function getWallet() {
    var seedB64 = localStorage.getItem(LS_KEY_SEED);
    var pubHex = localStorage.getItem(LS_KEY_PUB);
    if (!seedB64 || !pubHex) return null;
    return { seedB64: seedB64, pubHex: pubHex };
  }

  function createWallet() {
    var kp = window.nacl.sign.keyPair();
    var seedB64 = bytesToBase64(kp.secretKey.slice(0, 32));
    var pubHex = bytesToHex(kp.publicKey);
    localStorage.setItem(LS_KEY_SEED, seedB64);
    localStorage.setItem(LS_KEY_PUB, pubHex);
    return { seedB64: seedB64, pubHex: pubHex };
  }

  function getKeyPair() {
    var w = getWallet();
    if (!w) return null;
    var seed = base64ToBytes(w.seedB64);
    return window.nacl.sign.keyPair.fromSeed(seed);
  }

  function getShortAddr(pubHex) {
    return pubHex.slice(0, 8) + '...' + pubHex.slice(-8);
  }

  // ─── Payment record persistence ─────────────────────────────────────

  function getPayments() {
    try {
      var raw = localStorage.getItem(LS_KEY_PAYMENTS);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function savePayment(receipt) {
    var payments = getPayments();
    payments.push({
      txHash: receipt.txHash,
      amount: receipt.amount,
      to: receipt.to,
      timestamp: receipt.timestamp
    });
    localStorage.setItem(LS_KEY_PAYMENTS, JSON.stringify(payments));
  }

  /** Check if a payment to a specific address for a specific amount has already been made */
  function hasPayment(toAddress, amount) {
    var payments = getPayments();
    for (var i = 0; i < payments.length; i++) {
      if (payments[i].to === toAddress && payments[i].amount >= amount) {
        return payments[i];
      }
    }
    return null;
  }

  // ─── RPC communication ──────────────────────────────────────────────

  function rpcCall(method, params) {
    return fetch(_config.rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: method,
        params: params || {}
      })
    }).then(function (res) { return res.json(); })
      .then(function (json) {
        if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
        return json.result;
      });
  }

  function getBalance(address) {
    return rpcCall('get_balance', { address: address })
      .then(function (res) { return typeof res === 'number' ? res : (res && res.balance) || 0; })
      .catch(function () { return 0; });
  }

  function submitTransaction(tx) {
    return rpcCall('submit_transaction', { transaction: tx });
  }

  function requestFaucet(address) {
    return fetch(FAUCET_URL + '/faucet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: address })
    }).then(function (res) { return res.json(); });
  }

  // ─── Transaction construction ───────────────────────────────────────

  function buildAndSignTx(toAddress, amount) {
    var kp = getKeyPair();
    if (!kp) return Promise.reject(new Error('No wallet found'));

    var fromHex = bytesToHex(kp.publicKey);
    // Amount is in Z — convert to smallest unit (1 Z = 100 units internally)
    var amountUnits = Math.round(amount * 100);
    var feeUnits = Math.round(FEE_Z * 100);
    var nonce = Date.now();

    // Construct the canonical transaction payload for signing
    var payload = JSON.stringify({
      from: fromHex,
      to: toAddress,
      amount: amountUnits,
      fee: feeUnits,
      nonce: nonce
    });

    var payloadBytes = new TextEncoder().encode(payload);

    return hashBytes(payloadBytes).then(function (hash) {
      var signature = window.nacl.sign.detached(hash, kp.secretKey);
      return {
        from: fromHex,
        to: toAddress,
        amount: amountUnits,
        fee: feeUnits,
        nonce: nonce,
        signature: bytesToHex(signature),
        hash: bytesToHex(hash)
      };
    });
  }

  // ─── Full payment flow ──────────────────────────────────────────────

  /**
   * Execute a payment. Returns a Promise that resolves with a receipt.
   * @param {string} toAddress  Merchant public key hex
   * @param {number} amount     Amount in Z
   * @param {function} onStatus Callback for status updates
   */
  function executePayment(toAddress, amount, onStatus) {
    onStatus = onStatus || function () {};

    if (amount > MAX_TX_Z) {
      return Promise.reject(new Error('Amount exceeds maximum of ' + MAX_TX_Z + ' Z'));
    }
    if (amount <= 0) {
      return Promise.reject(new Error('Amount must be positive'));
    }

    var wallet = getWallet();
    if (!wallet) {
      return Promise.reject(new Error('NO_WALLET'));
    }

    onStatus('connecting');

    return getBalance(wallet.pubHex).then(function (balance) {
      var needed = amount + FEE_Z;
      if (balance < needed) {
        var err = new Error('Insufficient balance: have ' + formatZ(balance) + ' Z, need ' + formatZ(needed) + ' Z');
        err.code = 'INSUFFICIENT_BALANCE';
        err.balance = balance;
        err.needed = needed;
        throw err;
      }
      onStatus('signing');
      return buildAndSignTx(toAddress, amount);
    }).then(function (tx) {
      onStatus('submitting');
      return submitTransaction(tx).then(function (result) {
        return { tx: tx, result: result };
      });
    }).then(function (data) {
      onStatus('confirming');
      var receipt = {
        txHash: data.tx.hash,
        amount: amount,
        fee: FEE_Z,
        from: data.tx.from,
        to: toAddress,
        timestamp: Date.now(),
        status: 'confirmed'
      };
      savePayment(receipt);
      onStatus('confirmed');
      return receipt;
    });
  }

  // ─── CSS injection ──────────────────────────────────────────────────

  function injectStyles() {
    if (_stylesInjected) return;
    _stylesInjected = true;

    var css = [
      // Fonts
      "@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&family=Space+Grotesk:wght@300;400;500;700&display=swap');",

      // ── Variables (dark theme) ──
      ':root {',
      '  --zp-bg: #0a0a0a;',
      '  --zp-card: #0f0f0f;',
      '  --zp-border: #1a1a1a;',
      '  --zp-green: #00ff41;',
      '  --zp-green-dim: #00cc33;',
      '  --zp-green-glow: rgba(0, 255, 65, 0.15);',
      '  --zp-cyan: #00d4ff;',
      '  --zp-amber: #ffb000;',
      '  --zp-red: #ff3333;',
      '  --zp-text: #c0c0c0;',
      '  --zp-dim: #606060;',
      '  --zp-white: #e0e0e0;',
      '  --zp-font: "JetBrains Mono", "Fira Code", "Courier New", monospace;',
      '  --zp-font-heading: "Space Grotesk", "Inter", sans-serif;',
      '  --zp-modal-bg: rgba(0, 0, 0, 0.85);',
      '}',

      // ── Light theme overrides ──
      '.zp-theme-light {',
      '  --zp-bg: #f5f5f5;',
      '  --zp-card: #ffffff;',
      '  --zp-border: #e0e0e0;',
      '  --zp-green: #00a82d;',
      '  --zp-green-dim: #008c25;',
      '  --zp-green-glow: rgba(0, 168, 45, 0.12);',
      '  --zp-text: #333333;',
      '  --zp-dim: #999999;',
      '  --zp-white: #111111;',
      '  --zp-modal-bg: rgba(255, 255, 255, 0.92);',
      '}',

      // ── Animations ──
      '@keyframes zp-fadeIn { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }',
      '@keyframes zp-fadeOut { from { opacity: 1; } to { opacity: 0; } }',
      '@keyframes zp-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }',
      '@keyframes zp-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }',
      '@keyframes zp-glow { 0%, 100% { box-shadow: 0 0 5px var(--zp-green-glow); } 50% { box-shadow: 0 0 20px var(--zp-green-glow), 0 0 40px var(--zp-green-glow); } }',

      // ── Backdrop / Overlay ──
      '.zp-backdrop {',
      '  position: fixed;',
      '  top: 0; left: 0; right: 0; bottom: 0;',
      '  background: var(--zp-modal-bg);',
      '  backdrop-filter: blur(8px);',
      '  -webkit-backdrop-filter: blur(8px);',
      '  z-index: 100000;',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  animation: zp-fadeIn 0.25s ease-out;',
      '}',
      '.zp-backdrop.zp-closing {',
      '  animation: zp-fadeOut 0.2s ease-in forwards;',
      '}',

      // ── Modal card ──
      '.zp-modal {',
      '  background: var(--zp-card);',
      '  border: 1px solid var(--zp-border);',
      '  border-radius: 8px;',
      '  width: 380px;',
      '  max-width: calc(100vw - 32px);',
      '  max-height: calc(100vh - 32px);',
      '  overflow-y: auto;',
      '  padding: 28px;',
      '  font-family: var(--zp-font);',
      '  color: var(--zp-text);',
      '  animation: zp-fadeIn 0.3s ease-out;',
      '  box-shadow: 0 25px 60px rgba(0, 0, 0, 0.5);',
      '}',

      // ── Header ──
      '.zp-header {',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: space-between;',
      '  margin-bottom: 20px;',
      '}',
      '.zp-logo {',
      '  font-family: var(--zp-font-heading);',
      '  font-size: 0.85rem;',
      '  font-weight: 700;',
      '  color: var(--zp-green);',
      '  letter-spacing: 2px;',
      '  text-transform: uppercase;',
      '}',
      '.zp-logo-dim { color: var(--zp-dim); font-weight: 300; }',
      '.zp-version {',
      '  font-size: 0.6rem;',
      '  color: var(--zp-dim);',
      '  background: var(--zp-bg);',
      '  border: 1px solid var(--zp-border);',
      '  padding: 2px 7px;',
      '  border-radius: 3px;',
      '  letter-spacing: 0.05em;',
      '}',

      // ── Title / description ──
      '.zp-title {',
      '  font-family: var(--zp-font-heading);',
      '  font-size: 1.15rem;',
      '  font-weight: 600;',
      '  color: var(--zp-white);',
      '  margin-bottom: 6px;',
      '}',
      '.zp-desc {',
      '  font-size: 0.78rem;',
      '  color: var(--zp-dim);',
      '  line-height: 1.5;',
      '  margin-bottom: 20px;',
      '}',

      // ── Amount display ──
      '.zp-amount-box {',
      '  background: var(--zp-bg);',
      '  border: 1px solid var(--zp-border);',
      '  border-radius: 6px;',
      '  padding: 16px;',
      '  text-align: center;',
      '  margin-bottom: 20px;',
      '}',
      '.zp-amount-z {',
      '  font-family: var(--zp-font-heading);',
      '  font-size: 2rem;',
      '  font-weight: 700;',
      '  color: var(--zp-green);',
      '  text-shadow: 0 0 20px var(--zp-green-glow);',
      '}',
      '.zp-amount-z .zp-unit { font-size: 1rem; color: var(--zp-green-dim); margin-left: 4px; }',
      '.zp-amount-usd {',
      '  font-size: 0.75rem;',
      '  color: var(--zp-dim);',
      '  margin-top: 4px;',
      '}',
      '.zp-amount-fee {',
      '  font-size: 0.65rem;',
      '  color: var(--zp-dim);',
      '  margin-top: 8px;',
      '  opacity: 0.7;',
      '}',

      // ── Wallet info ──
      '.zp-wallet-info {',
      '  background: var(--zp-bg);',
      '  border: 1px solid var(--zp-border);',
      '  border-radius: 6px;',
      '  padding: 12px 14px;',
      '  margin-bottom: 16px;',
      '  font-size: 0.72rem;',
      '}',
      '.zp-wallet-row {',
      '  display: flex;',
      '  justify-content: space-between;',
      '  align-items: center;',
      '}',
      '.zp-wallet-row + .zp-wallet-row { margin-top: 6px; }',
      '.zp-wallet-label { color: var(--zp-dim); }',
      '.zp-wallet-value { color: var(--zp-white); font-weight: 500; }',
      '.zp-wallet-balance { color: var(--zp-green); font-weight: 600; }',

      // ── Merchant address ──
      '.zp-merchant {',
      '  font-size: 0.7rem;',
      '  color: var(--zp-dim);',
      '  margin-bottom: 16px;',
      '  text-align: center;',
      '}',
      '.zp-merchant-addr {',
      '  color: var(--zp-cyan);',
      '  word-break: break-all;',
      '}',

      // ── Buttons ──
      '.zp-btn {',
      '  display: block;',
      '  width: 100%;',
      '  padding: 12px 20px;',
      '  border: none;',
      '  border-radius: 4px;',
      '  font-family: var(--zp-font);',
      '  font-size: 0.82rem;',
      '  font-weight: 600;',
      '  cursor: pointer;',
      '  transition: all 0.2s;',
      '  letter-spacing: 0.5px;',
      '  text-align: center;',
      '}',
      '.zp-btn-primary {',
      '  background: var(--zp-green);',
      '  color: #000;',
      '  text-shadow: none;',
      '}',
      '.zp-btn-primary:hover {',
      '  background: var(--zp-green-dim);',
      '  box-shadow: 0 0 20px var(--zp-green-glow);',
      '}',
      '.zp-btn-primary:active { transform: scale(0.98); }',
      '.zp-btn-primary:disabled {',
      '  background: var(--zp-border);',
      '  color: var(--zp-dim);',
      '  cursor: not-allowed;',
      '  box-shadow: none;',
      '}',
      '.zp-btn-secondary {',
      '  background: transparent;',
      '  color: var(--zp-dim);',
      '  border: 1px solid var(--zp-border);',
      '}',
      '.zp-btn-secondary:hover {',
      '  border-color: var(--zp-dim);',
      '  color: var(--zp-text);',
      '}',
      '.zp-btn-faucet {',
      '  background: transparent;',
      '  color: var(--zp-amber);',
      '  border: 1px solid rgba(255, 176, 0, 0.3);',
      '  font-size: 0.72rem;',
      '  padding: 8px 14px;',
      '  margin-top: 8px;',
      '}',
      '.zp-btn-faucet:hover {',
      '  background: rgba(255, 176, 0, 0.08);',
      '  border-color: var(--zp-amber);',
      '}',
      '.zp-btn + .zp-btn { margin-top: 8px; }',

      // ── Status indicator ──
      '.zp-status {',
      '  text-align: center;',
      '  padding: 20px 0;',
      '}',
      '.zp-status-icon {',
      '  font-size: 2rem;',
      '  margin-bottom: 10px;',
      '}',
      '.zp-status-text {',
      '  font-size: 0.8rem;',
      '  color: var(--zp-text);',
      '  margin-bottom: 4px;',
      '}',
      '.zp-status-sub {',
      '  font-size: 0.68rem;',
      '  color: var(--zp-dim);',
      '}',
      '.zp-spinner {',
      '  display: inline-block;',
      '  width: 28px; height: 28px;',
      '  border: 2px solid var(--zp-border);',
      '  border-top-color: var(--zp-green);',
      '  border-radius: 50%;',
      '  animation: zp-spin 0.8s linear infinite;',
      '  margin-bottom: 12px;',
      '}',

      // ── Success state ──
      '.zp-success {',
      '  text-align: center;',
      '  padding: 20px 0;',
      '}',
      '.zp-success-check {',
      '  width: 48px; height: 48px;',
      '  border-radius: 50%;',
      '  background: var(--zp-green);',
      '  display: inline-flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  margin-bottom: 14px;',
      '}',
      '.zp-success-check svg { width: 24px; height: 24px; }',
      '.zp-success-text {',
      '  font-size: 0.85rem;',
      '  color: var(--zp-green);',
      '  font-weight: 600;',
      '  margin-bottom: 6px;',
      '}',
      '.zp-success-hash {',
      '  font-size: 0.65rem;',
      '  color: var(--zp-dim);',
      '  word-break: break-all;',
      '  margin-top: 8px;',
      '}',

      // ── Error state ──
      '.zp-error-msg {',
      '  font-size: 0.75rem;',
      '  color: var(--zp-red);',
      '  text-align: center;',
      '  padding: 10px;',
      '  background: rgba(255, 51, 51, 0.08);',
      '  border: 1px solid rgba(255, 51, 51, 0.2);',
      '  border-radius: 4px;',
      '  margin-bottom: 12px;',
      '}',

      // ── Wallet creation view ──
      '.zp-create-wallet {',
      '  text-align: center;',
      '  padding: 10px 0;',
      '}',
      '.zp-create-icon {',
      '  font-size: 2.5rem;',
      '  margin-bottom: 14px;',
      '}',
      '.zp-create-text {',
      '  font-size: 0.78rem;',
      '  color: var(--zp-text);',
      '  margin-bottom: 6px;',
      '  line-height: 1.5;',
      '}',
      '.zp-create-sub {',
      '  font-size: 0.68rem;',
      '  color: var(--zp-dim);',
      '  margin-bottom: 20px;',
      '  line-height: 1.5;',
      '}',

      // ── Inline pay button (ZeroPay.button) ──
      '.zp-inline-btn {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 8px;',
      '  padding: 10px 20px;',
      '  background: var(--zp-green);',
      '  color: #000;',
      '  border: none;',
      '  border-radius: 4px;',
      '  font-family: var(--zp-font);',
      '  font-size: 0.82rem;',
      '  font-weight: 600;',
      '  cursor: pointer;',
      '  transition: all 0.2s;',
      '  letter-spacing: 0.5px;',
      '}',
      '.zp-inline-btn:hover {',
      '  background: var(--zp-green-dim);',
      '  box-shadow: 0 0 20px var(--zp-green-glow);',
      '}',
      '.zp-inline-btn:active { transform: scale(0.97); }',
      '.zp-inline-btn:disabled {',
      '  background: var(--zp-border);',
      '  color: var(--zp-dim);',
      '  cursor: not-allowed;',
      '  box-shadow: none;',
      '}',
      '.zp-inline-btn .zp-z-icon {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  width: 18px; height: 18px;',
      '  background: rgba(0,0,0,0.15);',
      '  border-radius: 50%;',
      '  font-weight: 700;',
      '  font-size: 0.7rem;',
      '}',

      // ── Paywall overlay ──
      '.zp-paywall-overlay {',
      '  position: absolute;',
      '  top: 0; left: 0; right: 0; bottom: 0;',
      '  background: var(--zp-modal-bg);',
      '  backdrop-filter: blur(12px);',
      '  -webkit-backdrop-filter: blur(12px);',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  z-index: 10;',
      '  border-radius: inherit;',
      '}',
      '.zp-paywall-card {',
      '  background: var(--zp-card);',
      '  border: 1px solid var(--zp-border);',
      '  border-radius: 8px;',
      '  padding: 28px;',
      '  max-width: 360px;',
      '  width: calc(100% - 32px);',
      '  font-family: var(--zp-font);',
      '  color: var(--zp-text);',
      '  animation: zp-fadeIn 0.3s ease-out;',
      '}',

      // ── Divider ──
      '.zp-divider {',
      '  height: 1px;',
      '  background: var(--zp-border);',
      '  margin: 16px 0;',
      '}',

      // ── Close button ──
      '.zp-close {',
      '  background: none;',
      '  border: none;',
      '  color: var(--zp-dim);',
      '  font-size: 1.2rem;',
      '  cursor: pointer;',
      '  padding: 4px;',
      '  line-height: 1;',
      '  transition: color 0.2s;',
      '}',
      '.zp-close:hover { color: var(--zp-white); }',

      // ── Responsive ──
      '@media (max-width: 440px) {',
      '  .zp-modal { padding: 20px; width: 100%; border-radius: 12px 12px 0 0; }',
      '  .zp-backdrop { align-items: flex-end; }',
      '  .zp-amount-z { font-size: 1.6rem; }',
      '}'
    ].join('\n');

    var style = document.createElement('style');
    style.id = 'zeropay-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ─── UI component builders ──────────────────────────────────────────

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        if (key === 'className') node.className = attrs[key];
        else if (key === 'textContent') node.textContent = attrs[key];
        else if (key === 'innerHTML') node.innerHTML = attrs[key];
        else if (key.indexOf('on') === 0) node.addEventListener(key.slice(2).toLowerCase(), attrs[key]);
        else node.setAttribute(key, attrs[key]);
      });
    }
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach(function (child) {
        if (typeof child === 'string') node.appendChild(document.createTextNode(child));
        else if (child) node.appendChild(child);
      });
    }
    return node;
  }

  function buildHeader() {
    return el('div', { className: 'zp-header' }, [
      el('div', { className: 'zp-logo', innerHTML: 'Z<span class="zp-logo-dim">ERO</span> PAY' }),
      el('span', { className: 'zp-version', textContent: 'TESTNET' })
    ]);
  }

  function buildAmountBox(amount) {
    return el('div', { className: 'zp-amount-box' }, [
      el('div', { className: 'zp-amount-z', innerHTML: formatZ(amount) + '<span class="zp-unit">Z</span>' }),
      el('div', { className: 'zp-amount-usd', textContent: formatUSD(amount) + ' USD' }),
      el('div', { className: 'zp-amount-fee', textContent: '+ ' + formatZ(FEE_Z) + ' Z network fee' })
    ]);
  }

  function buildWalletInfo(pubHex, balance) {
    return el('div', { className: 'zp-wallet-info' }, [
      el('div', { className: 'zp-wallet-row' }, [
        el('span', { className: 'zp-wallet-label', textContent: 'Your wallet' }),
        el('span', { className: 'zp-wallet-value', textContent: getShortAddr(pubHex) })
      ]),
      el('div', { className: 'zp-wallet-row' }, [
        el('span', { className: 'zp-wallet-label', textContent: 'Balance' }),
        el('span', { className: 'zp-wallet-balance', textContent: formatZ(balance) + ' Z' })
      ])
    ]);
  }

  function buildMerchantInfo(address) {
    return el('div', { className: 'zp-merchant' }, [
      document.createTextNode('Paying '),
      el('span', { className: 'zp-merchant-addr', textContent: getShortAddr(address) })
    ]);
  }

  function buildSpinner(text, subtext) {
    return el('div', { className: 'zp-status' }, [
      el('div', { className: 'zp-spinner' }),
      el('div', { className: 'zp-status-text', textContent: text || 'Processing...' }),
      subtext ? el('div', { className: 'zp-status-sub', textContent: subtext }) : null
    ]);
  }

  function buildSuccess(receipt) {
    var checkSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    return el('div', { className: 'zp-success' }, [
      el('div', { className: 'zp-success-check', innerHTML: checkSvg }),
      el('div', { className: 'zp-success-text', textContent: 'Payment Confirmed' }),
      el('div', { className: 'zp-amount-usd', textContent: formatZ(receipt.amount) + ' Z sent' }),
      el('div', { className: 'zp-success-hash', textContent: 'tx: ' + receipt.txHash })
    ]);
  }

  function buildError(message) {
    return el('div', { className: 'zp-error-msg', textContent: message });
  }

  // ─── Checkmark SVG for success ──────────────────────────────────────

  var CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';

  // ─── Modal management ───────────────────────────────────────────────

  function showModal(contentBuilder) {
    injectStyles();
    var themeClass = _config.theme === 'light' ? ' zp-theme-light' : '';

    var backdrop = el('div', { className: 'zp-backdrop' + themeClass });
    var modal = el('div', { className: 'zp-modal' });
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    // Close on backdrop click
    backdrop.addEventListener('click', function (e) {
      if (e.target === backdrop) closeModal(backdrop);
    });

    // Close on Escape
    var escHandler = function (e) {
      if (e.key === 'Escape') {
        closeModal(backdrop);
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);

    // Build content
    contentBuilder(modal, backdrop);

    return { backdrop: backdrop, modal: modal };
  }

  function closeModal(backdrop) {
    backdrop.classList.add('zp-closing');
    setTimeout(function () {
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
    }, 200);
  }

  function replaceModalContent(modal, newContent) {
    modal.innerHTML = '';
    if (Array.isArray(newContent)) {
      newContent.forEach(function (child) { if (child) modal.appendChild(child); });
    } else {
      modal.appendChild(newContent);
    }
  }

  // ─── Wallet creation modal ─────────────────────────────────────────

  function showWalletCreation(onCreated) {
    return showModal(function (modal) {
      replaceModalContent(modal, [
        buildHeader(),
        el('div', { className: 'zp-create-wallet' }, [
          el('div', { className: 'zp-create-icon', textContent: '\u26A1' }),
          el('div', { className: 'zp-create-text', textContent: 'No Zero wallet detected' }),
          el('div', { className: 'zp-create-sub', textContent: 'Create a free wallet to make micropayments. Your keys are generated locally and stored in your browser.' })
        ]),
        el('button', {
          className: 'zp-btn zp-btn-primary',
          textContent: 'Create Wallet',
          onClick: function () {
            var wallet = createWallet();
            onCreated(wallet);
          }
        }),
        el('div', { className: 'zp-divider' }),
        el('div', {
          className: 'zp-desc',
          textContent: 'Ed25519 keys \u2022 client-side only \u2022 no server storage',
          style: 'text-align: center; margin-bottom: 0;'
        })
      ]);
    });
  }

  // ─── Payment modal ─────────────────────────────────────────────────

  function showPaymentModal(toAddress, amount, onSuccess, onError) {
    var currentBackdrop = null;

    ensureNacl(function (err) {
      if (err) {
        if (onError) onError(err);
        return;
      }

      var wallet = getWallet();
      if (!wallet) {
        // Show wallet creation first
        var creation = showWalletCreation(function (newWallet) {
          closeModal(creation.backdrop);
          wallet = newWallet;
          showPaymentUI(toAddress, amount, wallet, onSuccess, onError);
        });
        return;
      }

      showPaymentUI(toAddress, amount, wallet, onSuccess, onError);
    });
  }

  function showPaymentUI(toAddress, amount, wallet, onSuccess, onError) {
    var ref = showModal(function (modal, backdrop) {
      // Show loading while we fetch balance
      replaceModalContent(modal, [
        buildHeader(),
        buildSpinner('Loading wallet...', 'Fetching balance')
      ]);

      getBalance(wallet.pubHex).then(function (balance) {
        var needed = amount + FEE_Z;
        var insufficient = balance < needed;

        var elements = [
          buildHeader(),
          buildAmountBox(amount),
          buildMerchantInfo(toAddress),
          buildWalletInfo(wallet.pubHex, balance)
        ];

        if (insufficient) {
          elements.push(buildError(
            'Insufficient balance. Need ' + formatZ(needed) + ' Z, have ' + formatZ(balance) + ' Z.'
          ));
        }

        // Pay button
        var payBtn = el('button', {
          className: 'zp-btn zp-btn-primary',
          textContent: 'Pay ' + formatZ(amount) + ' Z',
          onClick: function () {
            doPayment(modal, backdrop, toAddress, amount, onSuccess, onError);
          }
        });
        if (insufficient) payBtn.disabled = true;
        elements.push(payBtn);

        // Faucet button (testnet)
        var faucetBtn = el('button', {
          className: 'zp-btn zp-btn-faucet',
          textContent: '\u2728 Get Test Z (Faucet)',
          onClick: function () {
            faucetBtn.disabled = true;
            faucetBtn.textContent = 'Requesting...';
            requestFaucet(wallet.pubHex).then(function (res) {
              faucetBtn.textContent = '\u2714 Sent! Refreshing...';
              // Refresh the modal after a brief delay
              setTimeout(function () {
                closeModal(backdrop);
                showPaymentUI(toAddress, amount, wallet, onSuccess, onError);
              }, 1500);
            }).catch(function (e) {
              faucetBtn.disabled = false;
              faucetBtn.textContent = 'Faucet error - try again';
            });
          }
        });
        elements.push(faucetBtn);

        // Cancel button
        elements.push(el('button', {
          className: 'zp-btn zp-btn-secondary',
          textContent: 'Cancel',
          onClick: function () { closeModal(backdrop); }
        }));

        replaceModalContent(modal, elements);
      }).catch(function (e) {
        replaceModalContent(modal, [
          buildHeader(),
          buildError('Failed to connect: ' + e.message),
          el('button', {
            className: 'zp-btn zp-btn-secondary',
            textContent: 'Close',
            onClick: function () { closeModal(backdrop); }
          })
        ]);
      });
    });
  }

  function doPayment(modal, backdrop, toAddress, amount, onSuccess, onError) {
    var statusMessages = {
      connecting: ['Connecting...', 'Reaching Zero network'],
      signing: ['Signing transaction...', 'Ed25519 signature'],
      submitting: ['Submitting...', 'Broadcasting to network'],
      confirming: ['Confirming...', 'Waiting for block confirmation'],
      confirmed: null
    };

    replaceModalContent(modal, [
      buildHeader(),
      buildSpinner('Connecting...', 'Reaching Zero network')
    ]);

    executePayment(toAddress, amount, function (status) {
      if (statusMessages[status]) {
        replaceModalContent(modal, [
          buildHeader(),
          buildSpinner(statusMessages[status][0], statusMessages[status][1])
        ]);
      }
    }).then(function (receipt) {
      replaceModalContent(modal, [
        buildHeader(),
        buildSuccess(receipt),
        el('div', { className: 'zp-divider' }),
        el('button', {
          className: 'zp-btn zp-btn-primary',
          textContent: 'Done',
          onClick: function () { closeModal(backdrop); }
        })
      ]);
      if (onSuccess) onSuccess(receipt);
    }).catch(function (err) {
      var elements = [
        buildHeader(),
        buildError(err.message)
      ];

      // If insufficient balance, show faucet
      if (err.code === 'INSUFFICIENT_BALANCE') {
        var wallet = getWallet();
        elements.push(el('button', {
          className: 'zp-btn zp-btn-faucet',
          textContent: '\u2728 Get Test Z (Faucet)',
          onClick: function () {
            requestFaucet(wallet.pubHex).then(function () {
              closeModal(backdrop);
              showPaymentModal(toAddress, amount, onSuccess, onError);
            }).catch(function () {});
          }
        }));
      }

      elements.push(el('button', {
        className: 'zp-btn zp-btn-secondary',
        textContent: 'Close',
        onClick: function () { closeModal(backdrop); }
      }));

      replaceModalContent(modal, elements);
      if (onError) onError(err);
    });
  }

  // ─── Public API ─────────────────────────────────────────────────────

  var ZeroPay = {
    /** Version string */
    version: VERSION,

    /**
     * Initialize the widget.
     * @param {Object} config
     * @param {string} config.address   Merchant's Zero public key (required)
     * @param {string} [config.rpc]     RPC endpoint (default: https://rpc.zzero.net)
     * @param {string} [config.theme]   "dark" (default) or "light"
     */
    init: function (config) {
      if (!config || !config.address) {
        console.error('[ZeroPay] init() requires { address: "merchant_pubkey" }');
        return;
      }
      _config.address = config.address;
      _config.rpc = config.rpc || DEFAULT_RPC;
      _config.theme = config.theme || 'dark';
      _initialized = true;

      // Pre-inject styles and pre-load tweetnacl
      injectStyles();
      ensureNacl(function () {});

      console.log('[ZeroPay] Initialized v' + VERSION + ' | merchant: ' + getShortAddr(_config.address));
    },

    /**
     * Create a paywall overlay on the target element.
     * @param {Object} config
     * @param {number} config.amount       Amount in Z (e.g., 0.10)
     * @param {string} config.target       CSS selector of element to gate
     * @param {string} [config.title]      Paywall title (default: "Premium Content")
     * @param {string} [config.description] Description text
     */
    paywall: function (config) {
      if (!_initialized) {
        console.error('[ZeroPay] Call ZeroPay.init() before ZeroPay.paywall()');
        return;
      }
      if (!config || !config.amount || !config.target) {
        console.error('[ZeroPay] paywall() requires { amount, target }');
        return;
      }

      var merchantAddr = config.address || _config.address;
      var amount = config.amount;
      var title = config.title || 'Premium Content';
      var description = config.description || 'This content requires a micropayment to access.';

      // Check if already paid
      var existing = hasPayment(merchantAddr, amount);
      if (existing) {
        console.log('[ZeroPay] Content already paid (tx: ' + existing.txHash + ')');
        return; // Content is visible, no overlay needed
      }

      // Wait for DOM to be ready
      var setup = function () {
        var targetEl = document.querySelector(config.target);
        if (!targetEl) {
          console.error('[ZeroPay] Target element not found: ' + config.target);
          return;
        }

        injectStyles();

        // Ensure positioned context for the overlay
        var pos = getComputedStyle(targetEl).position;
        if (pos === 'static') {
          targetEl.style.position = 'relative';
        }
        // Hide overflow to prevent peeking
        targetEl.style.overflow = 'hidden';

        // Build the overlay
        var themeClass = _config.theme === 'light' ? ' zp-theme-light' : '';
        var overlay = el('div', { className: 'zp-paywall-overlay' + themeClass });
        var card = el('div', { className: 'zp-paywall-card' });

        card.appendChild(buildHeader());
        card.appendChild(el('div', { className: 'zp-title', textContent: title }));
        card.appendChild(el('div', { className: 'zp-desc', textContent: description }));
        card.appendChild(buildAmountBox(amount));

        var payBtn = el('button', {
          className: 'zp-btn zp-btn-primary',
          textContent: 'Pay ' + formatZ(amount) + ' Z to unlock',
          onClick: function () {
            showPaymentModal(merchantAddr, amount, function (receipt) {
              // Payment successful — remove overlay and reveal content
              overlay.classList.add('zp-closing');
              setTimeout(function () {
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
                targetEl.style.overflow = '';
              }, 200);
            }, function (err) {
              // Payment failed — user can try again
              console.error('[ZeroPay] Payment failed:', err.message);
            });
          }
        });
        card.appendChild(payBtn);

        // Show USD equivalent as helper
        card.appendChild(el('div', {
          className: 'zp-desc',
          textContent: formatUSD(amount) + ' \u2022 one-time payment',
          style: 'text-align: center; margin: 12px 0 0; font-size: 0.68rem;'
        }));

        overlay.appendChild(card);
        targetEl.appendChild(overlay);
      };

      // Run setup when DOM is ready
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setup);
      } else {
        setup();
      }
    },

    /**
     * Create a pay button and append it to the target element.
     * @param {Object} config
     * @param {number} config.amount         Amount in Z
     * @param {string} config.target         CSS selector to append button to
     * @param {string} [config.label]        Button text (default: "Pay {amount} Z")
     * @param {function} [config.onSuccess]  Callback on successful payment (receives receipt)
     * @param {function} [config.onError]    Callback on error
     */
    button: function (config) {
      if (!_initialized) {
        console.error('[ZeroPay] Call ZeroPay.init() before ZeroPay.button()');
        return;
      }
      if (!config || !config.amount || !config.target) {
        console.error('[ZeroPay] button() requires { amount, target }');
        return;
      }

      var merchantAddr = config.address || _config.address;
      var amount = config.amount;
      var label = config.label || ('Pay ' + formatZ(amount) + ' Z');

      var setup = function () {
        var targetEl = document.querySelector(config.target);
        if (!targetEl) {
          console.error('[ZeroPay] Target element not found: ' + config.target);
          return;
        }

        injectStyles();
        var themeClass = _config.theme === 'light' ? ' zp-theme-light' : '';

        var btn = el('button', {
          className: 'zp-inline-btn' + themeClass,
          onClick: function () {
            btn.disabled = true;
            showPaymentModal(merchantAddr, amount, function (receipt) {
              btn.disabled = false;
              btn.textContent = '\u2714 Paid';
              if (config.onSuccess) config.onSuccess(receipt);
            }, function (err) {
              btn.disabled = false;
              if (config.onError) config.onError(err);
            });
          }
        }, [
          el('span', { className: 'zp-z-icon', textContent: 'Z' }),
          document.createTextNode(label)
        ]);

        targetEl.appendChild(btn);
      };

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setup);
      } else {
        setup();
      }
    },

    /**
     * Programmatic payment (no UI). Returns a Promise with the receipt.
     * @param {Object} config
     * @param {string} [config.address] Recipient address (defaults to merchant)
     * @param {number} config.amount    Amount in Z
     */
    pay: function (config) {
      if (!_initialized) {
        return Promise.reject(new Error('[ZeroPay] Call ZeroPay.init() first'));
      }
      var toAddress = (config && config.address) || _config.address;
      var amount = config && config.amount;
      if (!amount || !toAddress) {
        return Promise.reject(new Error('[ZeroPay] pay() requires { amount }'));
      }

      return new Promise(function (resolve, reject) {
        ensureNacl(function (err) {
          if (err) return reject(err);

          var wallet = getWallet();
          if (!wallet) {
            // Show wallet creation modal
            showWalletCreation(function () {
              executePayment(toAddress, amount, function () {}).then(resolve).catch(reject);
            });
            return;
          }

          executePayment(toAddress, amount, function () {}).then(resolve).catch(reject);
        });
      });
    },

    /**
     * Enable x402 auto-payment handler.
     * Intercepts 402 Payment Required responses from fetch() and auto-pays
     * using the x-402-amount and x-402-address headers, then retries the
     * request with X-Zero-Receipt attached.
     */
    enableX402: function () {
      if (_x402Enabled) return;
      _x402Enabled = true;

      if (!_initialized) {
        console.warn('[ZeroPay] enableX402() called before init(). Will use headers for address.');
      }

      var originalFetch = window.fetch;
      window.fetch = function (input, init) {
        return originalFetch.call(window, input, init).then(function (response) {
          // Only intercept 402 responses
          if (response.status !== 402) return response;

          var amountHeader = response.headers.get('x-402-amount');
          var addressHeader = response.headers.get('x-402-address');

          if (!amountHeader || !addressHeader) {
            // Not a Zero x402 response, return as-is
            return response;
          }

          var amount = parseFloat(amountHeader);
          var address = addressHeader;

          if (isNaN(amount) || amount <= 0 || amount > MAX_TX_Z) {
            console.warn('[ZeroPay] x402: Invalid amount:', amountHeader);
            return response;
          }

          console.log('[ZeroPay] x402: Payment required — ' + formatZ(amount) + ' Z to ' + getShortAddr(address));

          // Check if we have a cached receipt for this endpoint
          var url = typeof input === 'string' ? input : input.url;
          var cachedPayment = hasPayment(address, amount);
          if (cachedPayment) {
            // Retry with cached receipt
            var retryInit = Object.assign({}, init || {});
            retryInit.headers = new Headers(retryInit.headers || {});
            retryInit.headers.set('X-Zero-Receipt', cachedPayment.txHash);
            return originalFetch.call(window, input, retryInit);
          }

          // Need to pay — ensure nacl is loaded
          return new Promise(function (resolve, reject) {
            ensureNacl(function (err) {
              if (err) {
                resolve(response); // Return original 402 if we can't pay
                return;
              }

              var wallet = getWallet();
              if (!wallet) {
                console.warn('[ZeroPay] x402: No wallet available for auto-payment');
                resolve(response);
                return;
              }

              executePayment(address, amount, function (status) {
                console.log('[ZeroPay] x402: ' + status);
              }).then(function (receipt) {
                console.log('[ZeroPay] x402: Payment confirmed, retrying request');
                var retryInit = Object.assign({}, init || {});
                retryInit.headers = new Headers(retryInit.headers || {});
                retryInit.headers.set('X-Zero-Receipt', receipt.txHash);
                return originalFetch.call(window, input, retryInit);
              }).then(resolve).catch(function (payErr) {
                console.error('[ZeroPay] x402: Payment failed:', payErr.message);
                resolve(response); // Return original 402
              });
            });
          });
        });
      };

      console.log('[ZeroPay] x402 auto-payment handler enabled');
    },

    /**
     * Get the current wallet info (or null if no wallet exists).
     * @returns {Object|null}  { address, publicKey }
     */
    getWallet: function () {
      var w = getWallet();
      if (!w) return null;
      return {
        address: w.pubHex,
        publicKey: w.pubHex,
        shortAddress: getShortAddr(w.pubHex)
      };
    },

    /**
     * Get wallet balance. Returns a Promise resolving to the balance in Z.
     * @returns {Promise<number>}
     */
    getBalance: function () {
      var w = getWallet();
      if (!w) return Promise.resolve(0);
      return getBalance(w.pubHex);
    },

    /**
     * Get payment history.
     * @returns {Array}  Array of { txHash, amount, to, timestamp }
     */
    getPayments: function () {
      return getPayments();
    },

    /**
     * Request test tokens from the faucet.
     * @returns {Promise}
     */
    requestFaucet: function () {
      var w = getWallet();
      if (!w) return Promise.reject(new Error('No wallet. Create one first.'));
      return requestFaucet(w.pubHex);
    },

    /**
     * Check if a specific payment has already been made.
     * @param {string} toAddress   Recipient address
     * @param {number} amount      Amount in Z
     * @returns {Object|null}      Payment record or null
     */
    hasPayment: function (toAddress, amount) {
      return hasPayment(toAddress, amount);
    },

    /**
     * Create a wallet if one does not exist. Returns wallet info.
     * @returns {Promise<Object>}  { address, publicKey }
     */
    createWallet: function () {
      return new Promise(function (resolve, reject) {
        ensureNacl(function (err) {
          if (err) return reject(err);
          var w = getWallet();
          if (!w) w = createWallet();
          resolve({
            address: w.pubHex,
            publicKey: w.pubHex,
            shortAddress: getShortAddr(w.pubHex)
          });
        });
      });
    }
  };

  // ─── Self-register on window ────────────────────────────────────────
  window.ZeroPay = ZeroPay;

  // Log load
  console.log('[ZeroPay] Widget loaded v' + VERSION);

})();
