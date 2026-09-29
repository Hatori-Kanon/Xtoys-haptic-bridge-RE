// ============================================================================
// XtoysLOG_v3.2.js — XToys + Slowdown Slider (Resilient Popup Edition)
// RPG Maker MV/MZ plugin
//
// Changelog:
//   v3.2 — Fixed: webhook stops after window focus change.
//          Root cause: popupCall's catch block set _xtoys_popup=null which
//          overwrote the freshly-created popup reference. Fixed by:
//          1. NEVER clearing _xtoys_popup inside popupCall.
//          2. Detecting stale popup reference before writing.
//          3. Auto-syncing popup reference every 2s.
//          4. Removing auto-reopen-on-focus (annoying).
//          修复：切窗口后 webhook 停止发送的问题。
// ============================================================================

/*:
 * @plugindesc [v3.2] XToys Webhook + Battle Slowdown slider — resilient.
 * @author XtoysLOG
 *
 * @param Webhook ID
 * @desc Your XToys webhook ID.
 * @default pbCxy3VvyKxO
 *
 * @param Slowdown Rate
 * @type number @min 0.5 @max 10.0 @decimals 1
 * @desc Default slowdown rate. 1.0=原速, 2.0=慢一倍
 * @default 2.0
 *
 * @param Min Rate
 * @type number @min 0.5 @max 1.0 @decimals 1
 * @desc Fastest allowed rate.
 * @default 0.5
 *
 * @param Max Rate
 * @type number @min 1.0 @max 10.0 @decimals 1
 * @desc Slowest allowed rate.
 * @default 5.0
 *
 * @param Hotkey
 * @type select
 * @option none @value none
 * @option F2 @value f2
 * @option F3 @value f3
 * @option Tab @value tab
 * @desc Hotkey to toggle the popup.
 * @default f2
 *
 * @param Verbose Log
 * @type boolean
 * @desc Print startup info to console.
 * @default false
 */

var Imported = Imported || {};
Imported.XtoysLOG = true;

(function() {
    'use strict';

    // ======================================================================
    // 1. Parameters
    // ======================================================================

    var parameters = PluginManager.parameters('XtoysWS');
    var _webhook_id  = parameters['Webhook ID'] || '';
    var _defaultRate = Number(parameters['Slowdown Rate'] || '1.5');
    var _minRate     = Number(parameters['Min Rate'] || '0.5');
    var _maxRate     = Number(parameters['Max Rate'] || '5.0');
    var _panelHotkey = parameters['Hotkey'] || 'f2';
    var _verbose     = (parameters['Verbose Log'] || 'false') === 'true';
    var _currentRate = _defaultRate;

    // ======================================================================
    // 2. State
    // ======================================================================

    var _xtoys_popup       = null;
    var _xtoys_reopen_btn  = null;
    var _log_buffer        = [];

    var _last_detected_part = '胴体';
    var _last_trigger_time  = 0;
    var _active_actor       = null;
    var _climax_lock_until  = 0;
    var _pending_climax_actor = null;
    var _climax_timer       = null;
    var _indicator          = null;

    // ======================================================================
    // 3. Constants
    // ======================================================================

    var TRIGGER_GAP = 150;
    var VALID_PARTS = [
        '左胸','右胸','左乳首','右乳首','左足','右足',
        '胴体','尻','クリ','クリスタルコア','背中','プラグ','淫紋'
    ];
    var CLIMAX_LOCK_MS = 10000;
    var CLIMAX_WAIT_MS = 4000;

    // ======================================================================
    // 4. Popup-safe layer — NEVER crashes, NEVER clears _xtoys_popup in hot path
    // ======================================================================

    function popupAlive() {
        if (!_xtoys_popup) return false;
        if (_xtoys_popup.closed) {
            _xtoys_popup = null;
            return false;
        }
        try {
            if (!_xtoys_popup.xtoysLogApp) return false;
            if (typeof _xtoys_popup.xtoysLogApp.appendLog !== 'function') return false;
        } catch(e) {
            _xtoys_popup = null;
            return false;
        }
        return true;
    }

    function popupCallSafe(method, a, b) {
        if (!popupAlive()) return false;
        try {
            var api = _xtoys_popup.xtoysLogApp;
            if (typeof api[method] === 'function') {
                api[method](a, b);
                return true;
            }
        } catch(e) {
            // Silently fail — popup is dead, storage reference was already handled by popupAlive()
        }
        return false;
    }

    // ======================================================================
    // 5. Slowdown logic
    // ======================================================================

    function getRate() { return _currentRate; }

    function setRate(val) {
        _currentRate = Math.round(val * 10) / 10;
        if (_currentRate < _minRate) _currentRate = _minRate;
        if (_currentRate > _maxRate) _currentRate = _maxRate;
        updateIndicator();
    }

    function inBattle() {
        return $gameParty && $gameParty.inBattle && $gameParty.inBattle();
    }

    function slow(n) {
        if (!inBattle()) return n;
        var r = Math.round(n * getRate());
        return r < 1 ? 1 : r;
    }

    var _orig_wait = Game_Interpreter.prototype.wait;
    Game_Interpreter.prototype.wait = function(d) { _orig_wait.call(this, slow(d)); };

    var _orig_messageSpeed = Window_BattleLog.prototype.messageSpeed;
    Window_BattleLog.prototype.messageSpeed = function() { return slow(_orig_messageSpeed.call(this)); };

    var _orig_updateWaitCount = Window_BattleLog.prototype.updateWaitCount;
    Window_BattleLog.prototype.updateWaitCount = function() {
        if (inBattle() && this._waitCount > 0) {
            var dec = Math.max(1, Math.round(1 / getRate()));
            this._waitCount -= dec;
            if (this._waitCount < 0) this._waitCount = 0;
            return this._waitCount > 0;
        }
        return _orig_updateWaitCount.call(this);
    };

    var _orig_Anim_setup = Sprite_Animation.prototype.setup;
    Sprite_Animation.prototype.setup = function(t,a,m,d) { _orig_Anim_setup.call(this, t, a, m, slow(d)); };

    var _orig_Anim_setupRate = Sprite_Animation.prototype.setupRate;
    Sprite_Animation.prototype.setupRate = function() {
        _orig_Anim_setupRate.call(this);
        var r = Math.round(this._rate * getRate());
        this._rate = r < 1 ? 1 : r;
    };

    if (BattleManager.actionPerformAction) {
        var _orig_actionPerformAction = BattleManager.actionPerformAction;
        BattleManager.actionPerformAction = function() {
            if (inBattle() && this._logWindow) {
                var prev = this._logWindow._waitCount;
                var result = _orig_actionPerformAction.call(this);
                var added = this._logWindow._waitCount - prev;
                if (added > 0) this._logWindow._waitCount = prev + Math.round(added * getRate());
                return result;
            }
            return _orig_actionPerformAction.call(this);
        };
    }

    // ======================================================================
    // 6. Indicator
    // ======================================================================

    function createIndicator() {
        if (_indicator) return;
        _indicator = document.createElement('div');
        _indicator.id = 'xtoyslog-indicator';
        _indicator.title = 'Click to open XToys panel / 点击打开 XToys 面板';
        _indicator.style.cssText = [
            'position:absolute','right:36px','top:8px',
            'padding:3px 8px',
            'background:rgba(0,0,0,0.7)','color:#0FF',
            'border:1px solid rgba(0,170,255,0.5)','border-radius:4px',
            'z-index:1000000','cursor:pointer',
            'font-family:Consolas,monospace','font-size:12px',
            'font-weight:bold',
            'pointer-events:auto','user-select:none'
        ].join(';');
        _indicator.addEventListener('click', function(e) { e.stopPropagation(); openXtoysPopup(); });
        document.body.appendChild(_indicator);
        updateIndicator();
    }

    function updateIndicator() {
        if (!_indicator) return;
        if (!inBattle()) {
            _indicator.style.opacity = '0';
            _indicator.style.pointerEvents = 'none';
            return;
        }
        _indicator.style.opacity = '1';
        _indicator.style.pointerEvents = 'auto';
        var r = getRate();
        _indicator.textContent = r <= 0.7 ? '⚡ FAST' : r <= 1.0 ? '▶ 1x' : r <= 2.0 ? '🐢 ' + r.toFixed(1) + 'x' : '🐢🐢 ' + r.toFixed(1) + 'x';
    }

    // ======================================================================
    // 7. Webhook
    // ======================================================================

    function _getWebhookUrl() {
        return 'https://webhook.xtoys.app/' + (_webhook_id || '');
    }

    window.updateWebhookId = function(newId) {
        if (newId && newId.trim()) {
            _webhook_id = newId.trim();
            printToScreen('🔧 Webhook ID 已更新: ' + _webhook_id, '#00AAFF');
        } else {
            printToScreen('⚠️ Webhook ID 不能为空', '#FFAA00');
        }
    };

    window.updateSlowdownRate = function(val) {
        if (typeof val !== 'number') val = Number(val);
        if (isNaN(val)) return;
        _currentRate = Math.round(val * 10) / 10;
        if (_currentRate < _minRate) _currentRate = _minRate;
        if (_currentRate > _maxRate) _currentRate = _maxRate;
        updateIndicator();
    };

    // ======================================================================
    // 8. Popup HTML
    // ======================================================================

    function _escapeHtml(str) {
        return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
    }

    function _buildPopupHtml() {
        var id = _webhook_id;
        var rate = _currentRate;
        var r10   = Math.round(rate * 10);
        var min10 = Math.round(_minRate * 10);
        var max10 = Math.round(_maxRate * 10);
        var defR10 = Math.round(_defaultRate * 10);

        var js = [
            '(function(){"use strict";',
            'var C=document.getElementById("log-container"),I=document.getElementById("webhook-input"),',
            'B=document.getElementById("save-btn"),S=document.getElementById("save-status"),',
            'R=document.getElementById("speed-slider"),V=document.getElementById("speed-value"),',
            'F=document.getElementById("footer-status"),D=document.getElementById("drag-bar"),',
            'suppress=false;',
            // Drag
            '(function(){var d=false,sx=0,sy=0,wx=0,wy=0;',
            'D.addEventListener("mousedown",function(e){if(e.button)return;var t=e.target.tagName;if(t==="INPUT"||t==="BUTTON"||t==="SELECT"||t==="TEXTAREA")return;d=true;sx=e.screenX;sy=e.screenY;wx=window.screenX;wy=window.screenY;e.preventDefault()});',
            'document.addEventListener("mousemove",function(e){if(!d)return;window.moveTo(wx+e.screenX-sx,wy+e.screenY-sy)});',
            'document.addEventListener("mouseup",function(e){if(!d)return;d=false;window.moveTo(wx+e.screenX-sx,wy+e.screenY-sy)})})();',
            // Connection
            'function ok(){return window.opener&&!window.opener.closed}',
            'function conn(){F.textContent=ok()?"🟢 Connected / 已连接":"🔴 Disconnected / 未连接"}',
            'conn();setInterval(conn,2000);',
            // Save webhook
            'function flash(m,c){S.textContent=m;S.style.color=c||"#0F0";setTimeout(function(){S.textContent=""},2500)}',
            'function doSave(){if(ok()){window.opener.updateWebhookId(I.value);flash("✓ Saved","#00FF00")}else{flash("✗ No connection","#FF4444")}}',
            'B.onclick=doSave;I.onkeydown=function(e){if(e.key==="Enter")doSave()};',
            // Slider
            'function setSliderUI(v10){suppress=true;R.value=v10;V.textContent=(v10/10).toFixed(1)+"x";suppress=false}',
            'R.addEventListener("input",function(){if(suppress)return;var v=Number(R.value)/10;V.textContent=v.toFixed(1)+"x";if(ok())window.opener.updateSlowdownRate(v)});',
            'R.addEventListener("change",function(){if(suppress)return;var v=Number(R.value)/10;if(ok())window.opener.updateSlowdownRate(v)});',
            '(function(){var ps=document.querySelectorAll("#speed-presets span");for(var i=0;i<ps.length;i++){(function(p){p.onclick=function(){var r=Number(p.getAttribute("data-rate"))/10;setSliderUI(Math.round(r*10));if(ok())window.opener.updateSlowdownRate(r)}})(ps[i])}})();',
            'document.getElementById("reset-btn").onclick=function(){var r=' + _defaultRate + ';setSliderUI(' + defR10 + ');if(ok())window.opener.updateSlowdownRate(r)};',
            // API
            'window.xtoysLogApp={',
            'appendLog:function(t,c){var e=document.createElement("div");e.className="log-entry";e.style.color=c||"#FFF";e.textContent=t;C.appendChild(e);C.scrollTop=C.scrollHeight},',
            'setFooterStatus:function(t){F.textContent=t},',
            'setWebhookInput:function(v){I.value=v},',
            'setSlider:function(v){setSliderUI(Math.round(v*10))}',
            '};',
            'if(ok())window.opener._onPopupReady();',
            '})();'
        ].join('');

        return '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>XToys Control Panel</title>\n<style>\n'
            + '  *{margin:0;padding:0;box-sizing:border-box}\n'
            + '  body{background:#0A0A1A;color:#FFF;font-family:Consolas,"Courier New",monospace;font-size:12px;overflow:hidden;display:flex;flex-direction:column;height:100vh}\n'
            + '  ::-webkit-scrollbar{width:6px} ::-webkit-scrollbar-track{background:#0A0A1A} ::-webkit-scrollbar-thumb{background:#003355;border-radius:3px} ::-webkit-scrollbar-thumb:hover{background:#00AAFF}\n'
            + '  #drag-bar{background:#00152A;padding:8px 14px;border-bottom:2px solid #00AAFF;flex-shrink:0;user-select:none;cursor:move;display:flex;align-items:center}\n'
            + '  #drag-bar:active{background:#002244}\n'
            + '  #drag-bar .drag-icon{font-size:12px;color:#00AAFF;margin-right:8px;opacity:0.6;flex-shrink:0}\n'
            + '  #drag-bar .title{font-weight:bold;font-size:14px;color:#00AAFF;flex:1}\n'
            + '  #drag-bar .drag-hint{font-size:9px;color:#445;flex-shrink:0}\n'
            + '  #config-area{background:#00101A;padding:8px 14px;border-bottom:1px solid #003355;flex-shrink:0}\n'
            + '  #config-row{display:flex;align-items:center;gap:6px}\n'
            + '  #config-row label{color:#99A;white-space:nowrap;font-size:12px}\n'
            + '  #webhook-input{flex:1;background:#1A1A2E;color:#FFF;border:1px solid #00AAFF;padding:5px 8px;font-family:inherit;font-size:12px;border-radius:3px;outline:none}\n'
            + '  #webhook-input:focus{border-color:#33CCFF;box-shadow:0 0 4px rgba(0,170,255,0.4)}\n'
            + '  #webhook-input::placeholder{color:#445}\n'
            + '  #save-btn{background:#00AAFF;color:#000;border:none;padding:5px 14px;cursor:pointer;font-weight:bold;font-size:12px;border-radius:3px;transition:background 0.15s}\n'
            + '  #save-btn:hover{background:#33CCFF} #save-btn:active{background:#0088CC}\n'
            + '  #save-status{font-size:10px;color:#666;margin-left:4px;transition:color 0.3s;white-space:nowrap}\n'
            + '  #speed-area{background:#00101A;padding:8px 14px;border-bottom:1px solid #003355;flex-shrink:0}\n'
            + '  #speed-label-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px}\n'
            + '  #speed-label{color:#99A;font-size:11px}\n'
            + '  #speed-value{color:#0FF;font-size:13px;font-weight:bold;min-width:40px;text-align:right}\n'
            + '  #speed-slider-row{display:flex;align-items:center;gap:8px}\n'
            + '  #speed-slider-row .end-label{font-size:10px;color:#667;width:30px;text-align:center;flex-shrink:0}\n'
            + '  #speed-slider{flex:1;height:5px;cursor:pointer;accent-color:#00AAFF;background:#1A2A3A;border-radius:3px;outline:none}\n'
            + '  #speed-presets{display:flex;justify-content:space-between;padding:0 38px;margin-top:2px}\n'
            + '  #speed-presets span{font-size:9px;color:#556;cursor:pointer;user-select:none}\n'
            + '  #speed-presets span:hover{color:#0FF}\n'
            + '  #reset-btn-row{text-align:center;margin-top:6px}\n'
            + '  #reset-btn{background:rgba(0,170,255,0.15);color:#00AAFF;border:1px solid #00AAFF;border-radius:4px;padding:3px 14px;cursor:pointer;font-size:11px;font-family:inherit;transition:background 0.15s}\n'
            + '  #reset-btn:hover{background:rgba(0,170,255,0.3)}\n'
            + '  #log-container{flex:1;padding:6px 14px;overflow-y:auto}\n'
            + '  .log-entry{margin:1px 0;word-break:break-all;line-height:1.5}\n'
            + '  #footer{background:#00101A;padding:4px 14px;border-top:1px solid #003355;font-size:10px;color:#556;flex-shrink:0;display:flex;justify-content:space-between;user-select:none}\n'
            + '</style>\n</head>\n<body>\n'
            + '<div id="drag-bar"><span class="drag-icon">⠿</span><span class="title">XToys Control Panel</span><span class="drag-hint">drag to move / 拖动移动</span></div>\n'
            + '<div id="config-area"><div id="config-row"><label>Webhook ID:</label><input type="text" id="webhook-input" value="' + _escapeHtmlProcess(id) + '" placeholder="Enter your XToys Webhook ID"><button id="save-btn">Save</button><span id="save-status"></span></div></div>\n'
            + '<div id="speed-area">'
            + '<div id="speed-label-row"><span id="speed-label">⚙ 战斗减速倍率 / Slowdown Rate</span><span id="speed-value">' + rate.toFixed(1) + 'x</span></div>'
            + '<div id="speed-slider-row"><span class="end-label">' + _minRate.toFixed(1) + 'x</span><input type="range" id="speed-slider" min="' + min10 + '" max="' + max10 + '" step="1" value="' + r10 + '"><span class="end-label">' + _maxRate.toFixed(1) + 'x</span></div>'
            + '<div id="speed-presets"><span data-rate="10">1x</span><span data-rate="20">2x</span><span data-rate="30">3x</span><span data-rate="40">4x</span><span data-rate="50">5x</span></div>'
            + '<div id="reset-btn-row"><button id="reset-btn">Reset / 重置默认</button></div>'
            + '</div>\n'
            + '<div id="log-container"></div>\n'
            + '<div id="footer"><span id="footer-status">Initializing / 初始化中...</span><span>XtoysLOG v3.2</span></div>\n'
            + '<script>' + js + '<\/script>\n</body>\n</html>';
    }

    function _escapeHtmlProcess(str) {
        return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // ======================================================================
    // 9. Popup lifecycle
    // ======================================================================

    function openXtoysPopup() {
        if (popupAlive()) {
            _xtoys_popup.focus();
            popupCallSafe('setSlider', getRate());
            return true;
        }

        _xtoys_popup = null;

        var popup = window.open('', 'xtoys_log_window', 'width=540,height=780,scrollbars=yes,resizable=yes');
        if (!popup) {
            printToScreen('⚠️ 弹出窗口被拦截。请允许弹窗或点击右上角按钮。', '#FFAA00');
            return false;
        }

        popup.document.write(_buildPopupHtml());
        popup.document.close();
        _xtoys_popup = popup;

        var closeWatcher = setInterval(function() {
            if (_xtoys_popup && _xtoys_popup.closed) {
                _xtoys_popup = null;
                clearInterval(closeWatcher);
                if (_xtoys_reopen_btn) _xtoys_reopen_btn.style.display = 'block';
            }
        }, 1000);

        var readyTimeout = setTimeout(function() { _log_buffer = []; }, 5000);

        window._onPopupReady = function() {
            if (!popupAlive()) return;
            clearTimeout(readyTimeout);
            var ts = '[' + new Date().toLocaleTimeString() + '] ';
            popupCallSafe('appendLog', ts + '📡 XToys 控制面板已连接 / Control panel connected', '#00AAFF');
            popupCallSafe('setFooterStatus', '🟢 Connected / 已连接');
            _flushLogBuffer();
            popupCallSafe('setSlider', getRate());
        };

        return true;
    }

    function _flushLogBuffer() {
        if (_log_buffer.length === 0) return;
        if (!popupAlive()) return;
        for (var i = 0; i < _log_buffer.length; i++) {
            if (!popupCallSafe('appendLog', _log_buffer[i].text, _log_buffer[i].color)) {
                _log_buffer = _log_buffer.slice(i);
                return;
            }
        }
        _log_buffer = [];
    }

    // ======================================================================
    // 10. Game page UI
    // ======================================================================

    function initXtoysBoard() {
        if (_xtoys_reopen_btn) return;

        _xtoys_reopen_btn = document.createElement('button');
        _xtoys_reopen_btn.innerText = '📡 XToys';
        _xtoys_reopen_btn.style.cssText = [
            'position:absolute','left:10px','top:10px',
            'padding:4px 8px',
            'background:rgba(0,170,255,0.85)','color:#FFF',
            'border:1px solid rgba(255,255,255,0.4)','border-radius:4px',
            'z-index:1000001','cursor:pointer','font-weight:bold',
            'font-size:11px','font-family:"Segoe UI",sans-serif','pointer-events:auto'
        ].join(';');
        _xtoys_reopen_btn.addEventListener('click', function() { openXtoysPopup(); });
        document.body.appendChild(_xtoys_reopen_btn);

        createIndicator();

        var opened = openXtoysPopup();
        if (opened) _xtoys_reopen_btn.style.display = 'none';
    }

    // ======================================================================
    // 11. Hotkey
    // ======================================================================

    document.addEventListener('keydown', function(e) {
        var key = (e.key || '').toLowerCase();
        if (_panelHotkey !== 'none' && key === _panelHotkey) {
            e.preventDefault();
            openXtoysPopup();
        }
    });

    // ======================================================================
    // 12. Logging — always safe, webhook-independent
    // ======================================================================

    function printToScreen(text, color) {
        var full = '[' + new Date().toLocaleTimeString() + '] ' + text;
        var c = color || '#FFF';

        if (popupAlive() && popupCallSafe('appendLog', full, c)) return;

        _log_buffer.push({text: full, color: c});

        if (_xtoys_popup && !_xtoys_popup.closed) {
            (function att(n) {
                if (n <= 0) return;
                if (popupAlive()) { _flushLogBuffer(); if (_log_buffer.length === 0) return; }
                setTimeout(function() { att(n - 1); }, 150);
            })(20);
        }
    }

    // ======================================================================
    // 13. Helpers
    // ======================================================================

    function parseValidPart(text) {
        if (typeof text !== 'string') return null;
        var clean = text.replace(/【|】|\s/g, '');
        return VALID_PARTS.indexOf(clean) >= 0 ? clean : null;
    }

    function getDevLevel(part, actor) {
        if (!actor || !actor._aop) return 0;
        var idx = 6;
        if (['左胸','右胸','左乳首','右乳首'].indexOf(part) >= 0) idx = 4;
        if (['クリ','尻','プラグ','淫紋'].indexOf(part) >= 0) idx = 5;
        return actor._aop[idx] || 0;
    }

    // ======================================================================
    // 14. Webhook push — 100% independent of popup state
    // ======================================================================

    function sendToXtoys(payload, retryCount) {
        if (retryCount === undefined) retryCount = 0;
        if (!_webhook_id) { printToScreen('⚠️ Webhook ID 未设置，无法发送', '#FFAA00'); return; }

        fetch(_getWebhookUrl(), {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        }).then(function(r) {
            if (r.ok && payload.action === 'climax') {
                printToScreen('✅ [回执] XToys 服务器已确认接收高潮指令！', '#00FF00');
            } else if (!r.ok) {
                printToScreen('⚠️ XToys 拒绝 (状态码: ' + r.status + ')', '#FFAA00');
            }
        }).catch(function() {
            if (retryCount < 3 && payload.action === 'climax') {
                printToScreen('⚠️ [重试 ' + (retryCount + 1) + '/3] 高潮指令重发中...', '#FFAA00');
                setTimeout(function() { sendToXtoys(payload, retryCount + 1); }, 500);
            } else if (retryCount >= 3) {
                printToScreen('🔴 高潮指令丢失！请检查网络。', '#FF0000');
            }
        });
    }

    // ======================================================================
    // 15. Climax pending
    // ======================================================================

    function scheduleClimax(actor) {
        _pending_climax_actor = actor;
        printToScreen('⏳ [高潮预备] 检测到忍耐击穿，等待攻击动画结束...', '#AAAAAA');
        resetClimaxTimer();
    }

    function resetClimaxTimer() {
        if (!_pending_climax_actor) return;
        clearTimeout(_climax_timer);
        _climax_timer = setTimeout(function() {
            var a = _pending_climax_actor;
            _pending_climax_actor = null;
            executeClimax(a);
        }, CLIMAX_WAIT_MS);
    }

    // ======================================================================
    // 16. Output
    // ======================================================================

    function executeOutput(reason, part) {
        var now = Date.now();
        if (now < _climax_lock_until) return;
        if (now - _last_trigger_time < TRIGGER_GAP) return;
        resetClimaxTimer();
        var actor = _active_actor || ($gameParty ? $gameParty.members()[0] : null);
        var dev = getDevLevel(part, actor);
        var name = actor ? actor.name() : '未知';
        printToScreen('📤 推流 [' + reason + '] -> 角色: ' + name + ' | 部位: ' + part, '#00FFFF');
        sendToXtoys({action:'hit', reason:reason, actor:name, part:part, devLevel:dev});
        _last_trigger_time = now;
    }

    function executePunishment(actor, typeName, increase) {
        if (Date.now() < _climax_lock_until) return;
        resetClimaxTimer();
        printToScreen('💀 推流 [精神惩罚] -> 角色: ' + actor.name() + ' | ' + typeName + ' +' + increase, '#FF0044');
        sendToXtoys({action:'punishment', actor:actor.name(), type:typeName, increase:increase});
    }

    function executeClimax(actor) {
        var now = Date.now();
        _climax_lock_until = now + CLIMAX_LOCK_MS;
        var dev = getDevLevel(_last_detected_part, actor);
        printToScreen('🌊 [绝顶高潮爆发！] 角色: ' + actor.name() + ' -> 开启过载锁', '#FF00FF');
        if (!_webhook_id) { printToScreen('⚠️ Webhook ID 未设置，高潮指令无法发送', '#FFAA00'); return; }
        var nonce = Math.random().toString(36).substring(7);
        var getUrl = _getWebhookUrl() + '?action=climax&actor=' + encodeURIComponent(actor.name()) + '&part=' + encodeURIComponent(_last_detected_part) + '&dev=' + dev + '&_t=' + now + '&_n=' + nonce;
        fetch(getUrl, {mode:'no-cors'})
        .then(function() { printToScreen('✅ [回执] 高潮指令已通过强发通道送达！', '#00FF00'); })
        .catch(function() { sendToXtoys({action:'climax', actor:actor.name(), part:_last_detected_part, devLevel:dev, timestamp:now}); });
    }

    // ======================================================================
    // 17. Data Hooking
    // ======================================================================

    var _xtoys_hook_setValue = Game_Variables.prototype.setValue;
    Game_Variables.prototype.setValue = function(id, value) {
        var part = parseValidPart(value);
        if (part) {
            _last_detected_part = part;
            executeOutput('动画节拍', part);
        }
        _xtoys_hook_setValue.call(this, id, value);
    };

    setInterval(function() {
        if (window.$gameParty) {
            $gameParty.members().forEach(function(actor) {
                if (!actor || !actor._aop || actor._aop._xtoys_monitored) return;
                printToScreen('🛡️ 挂载角色数据源: [' + actor.name() + ']', '#00FF00');
                actor._aop = new Proxy(actor._aop, {
                    set: function(target, prop, val) {
                        var old = target[prop];
                        if (old !== undefined && old !== val) {
                            _active_actor = actor;
                            if (prop === '0') {
                                if (val <= 0 && old > 0) scheduleClimax(actor);
                                else if (val < old && val > 0) executeOutput('忍耐下降', _last_detected_part);
                            } else if (['7','8','9'].indexOf(prop) >= 0 && val > old) {
                                var tn = prop === '7' ? '羞耻欲求' : (prop === '8' ? '背德甘受' : '魔力受容体污染');
                                executePunishment(actor, tn, val - old);
                            }
                        }
                        target[prop] = val;
                        return true;
                    }
                });
                actor._aop._xtoys_monitored = true;
            });
        }
    }, 1000);

    // ======================================================================
    // 18. Bootstrap
    // ======================================================================

    var _Scene_Boot_start = Scene_Boot.prototype.start;
    Scene_Boot.prototype.start = function() {
        _Scene_Boot_start.call(this);
        initXtoysBoard();
    };

    var _Scene_Battle_terminate = Scene_Battle.prototype.terminate;
    Scene_Battle.prototype.terminate = function() {
        _Scene_Battle_terminate.call(this);
        updateIndicator();
    };

    if (_verbose && typeof console !== 'undefined') {
        console.log('[XtoysLOG v3.2] Ready.');
    }

})();
