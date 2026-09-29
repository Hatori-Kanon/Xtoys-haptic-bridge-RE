//=============================================================================
// XtoysBridgeMZ.js
// RPG Maker MZ bridge: Repetition body-hit/EP/restraint/climax -> XToys webhook.
//=============================================================================

/*:
 * @target MZ
 * @plugindesc XToys webhook bridge for Repetition body hits, EP strength, restraint, and climax.
 * @author Codex
 *
 * @param Webhook ID
 * @desc XToys webhook ID. URL is https://webhook.xtoys.app/<Webhook ID>
 * @default
 *
 * @param Auto Open Panel
 * @type boolean
 * @default true
 *
 * @param Hit Cooldown Ms
 * @type number
 * @min 0
 * @default 120
 *
 * @param Climax Lock Ms
 * @type number
 * @min 0
 * @default 8000
 *
 * @param Log To File
 * @type boolean
 * @default true
 *
 * @help
 * Temporary formal bridge for "Repetition!" RPG Maker MZ 1.8.x.
 *
 * Observed mappings:
 *   Switch 83: generic EP attack in progress.
 *   Switch 84..94: EP body-part attack in progress.
 *   Variable 29: EP stock toward climax.
 *   Variable 40: current displayed EP.
 *   Variable 24: restraint stage.
 *   Variable 112: climax experience counter.
 *
 * Payload actions:
 *   hit       - body-part attack starts
 *   ep        - EP stock is settled after a hit
 *   restraint - restraint stage changes
 *   climax    - climax experience increases
 */

var Imported = Imported || {};
Imported.XtoysBridgeMZ = true;

(function() {
    "use strict";

    var PLUGIN_NAME = "XtoysBridgeMZ";
    var params = PluginManager.parameters(PLUGIN_NAME);
    var webhookId = String(params["Webhook ID"] || "").trim();
    var autoOpenPanel = String(params["Auto Open Panel"] || "true") === "true";
    var hitCooldownMs = Number(params["Hit Cooldown Ms"] || 120);
    var climaxLockMs = Number(params["Climax Lock Ms"] || 8000);
    var logToFile = String(params["Log To File"] || "true") === "true";

    var popup = null;
    var reopenButton = null;
    var bufferedLines = [];
    var lastHitAt = {};
    var lastPart = null;
    var lastClimaxAt = 0;
    var fs = null;
    var path = null;
    var logFile = "";
    var fileReady = false;

    var partMap = {
        83: { key: "generic_ep", label: "汎用EP", expVar: 111 },
        84: { key: "chest", label: "胸", expVar: 102 },
        85: { key: "nipple", label: "乳首", expVar: 103 },
        86: { key: "labia", label: "陰唇", expVar: 104 },
        87: { key: "clit", label: "クリ", expVar: 105 },
        88: { key: "vagina", label: "膣", expVar: 106 },
        89: { key: "mouth", label: "口", expVar: 107 },
        90: { key: "armpit", label: "腋", expVar: 108 },
        91: { key: "butt", label: "お尻", expVar: 109 },
        92: { key: "double_hole", label: "両穴", expVar: 110 },
        93: { key: "protrusion", label: "突起", expVar: 110 },
        94: { key: "whole_body", label: "全身", expVar: 110 }
    };

    function nowText() {
        var d = new Date();
        function pad(n, size) {
            var s = String(n);
            while (s.length < size) s = "0" + s;
            return s;
        }
        return pad(d.getHours(), 2) + ":" + pad(d.getMinutes(), 2) + ":" +
            pad(d.getSeconds(), 2) + "." + pad(d.getMilliseconds(), 3);
    }

    function initFileLog() {
        if (fileReady || !logToFile) return;
        try {
            if (typeof require !== "function") return;
            fs = require("fs");
            path = require("path");
            var base = (typeof process !== "undefined" && process.cwd) ? process.cwd() : ".";
            logFile = path.join(base, "xtoys_bridge_log.txt");
            fs.appendFileSync(logFile, "\n=== XtoysBridgeMZ started " + new Date().toISOString() + " ===\n", "utf8");
            fileReady = true;
        } catch (e) {
            fileReady = false;
        }
    }

    function writeFile(line) {
        if (!logToFile) return;
        try {
            initFileLog();
            if (fileReady && fs && logFile) fs.appendFileSync(logFile, line + "\n", "utf8");
        } catch (e) {
            fileReady = false;
        }
    }

    function popupAlive() {
        if (!popup || popup.closed) {
            popup = null;
            return false;
        }
        try {
            return !!(popup.XtoysBridgeApp && typeof popup.XtoysBridgeApp.appendLine === "function");
        } catch (e) {
            popup = null;
            return false;
        }
    }

    function log(kind, text) {
        var line = "[" + nowText() + "] [" + kind + "] " + text;
        writeFile(line);
        if (popupAlive()) {
            try {
                popup.XtoysBridgeApp.appendLine(line);
                return;
            } catch (e) {
                popup = null;
            }
        }
        bufferedLines.push(line);
        if (bufferedLines.length > 500) bufferedLines.shift();
        if (window.console && console.log) console.log(line);
    }

    function flushPopup() {
        if (!popupAlive()) return;
        while (bufferedLines.length) popup.XtoysBridgeApp.appendLine(bufferedLines.shift());
    }

    function webhookUrl() {
        return "https://webhook.xtoys.app/" + webhookId;
    }

    function send(action, payload, retry) {
        retry = retry || 0;
        if (!webhookId) {
            log("WARN", "Webhook ID is empty. Dropped action=" + action);
            return;
        }
        var body = Object.assign({ action: action }, payload || {});

        fetch(webhookUrl(), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        }).then(function(response) {
            if (response.ok) {
                log("SEND", action + " ok " + summarize(body));
            } else {
                log("WARN", action + " rejected status=" + response.status + " " + summarize(body));
            }
        }).catch(function() {
            if (retry < 2 && action === "climax") {
                setTimeout(function() {
                    send(action, payload, retry + 1);
                }, 500);
            } else {
                log("ERROR", action + " failed " + summarize(body));
            }
        });
    }

    function summarize(payload) {
        var fields = [];
        if (payload.part) fields.push("part=" + payload.part);
        if (payload.epGain !== undefined) fields.push("epGain=" + payload.epGain);
        if (payload.epStock !== undefined) fields.push("epStock=" + payload.epStock);
        if (payload.stage !== undefined) fields.push("stage=" + payload.stage);
        if (payload.climaxCount !== undefined) fields.push("climaxCount=" + payload.climaxCount);
        return fields.join(" ");
    }

    function sendHit(switchId) {
        var part = partMap[switchId];
        if (!part) return;
        var now = Date.now();
        if (lastHitAt[switchId] && now - lastHitAt[switchId] < hitCooldownMs) return;
        lastHitAt[switchId] = now;
        lastPart = part;

        send("hit", {
            part: part.key
        });
    }

    function sendEp(oldValue, newValue) {
        if (typeof oldValue !== "number" || typeof newValue !== "number") return;
        if (newValue <= oldValue) return;
        var gain = newValue - oldValue;
        var part = lastPart || { key: "unknown", label: "unknown" };
        send("ep", {
            part: part.key,
            epGain: gain,
            epStock: newValue
        });
    }

    function sendRestraint(oldValue, newValue) {
        if (oldValue === newValue) return;
        send("restraint", {
            stage: newValue
        });
    }

    function sendClimax(oldValue, newValue) {
        if (newValue <= oldValue) return;
        var now = Date.now();
        if (now - lastClimaxAt < climaxLockMs) return;
        lastClimaxAt = now;
        var part = lastPart || { key: "unknown", label: "unknown" };
        send("climax", {
            part: part.key,
            climaxCount: newValue
        });
    }

    function buildPanelHtml() {
        var escapedId = webhookId.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        return [
            "<!DOCTYPE html><html><head><meta charset='utf-8'><title>Xtoys Bridge MZ</title>",
            "<style>",
            "*{box-sizing:border-box}body{margin:0;background:#111722;color:#edf4ff;font:12px Consolas,'Courier New',monospace;height:100vh;display:flex;flex-direction:column;overflow:hidden}",
            "#bar{height:38px;background:#1a2738;border-bottom:1px solid #55a7ff;display:flex;align-items:center;gap:8px;padding:0 10px;cursor:move;user-select:none}",
            "#title{font-weight:bold;color:#8fd0ff;flex:1}button{background:#263a54;color:#edf4ff;border:1px solid #6385ad;border-radius:3px;padding:4px 8px;font:inherit;cursor:pointer}",
            "button:hover{background:#335070}#config{display:flex;gap:6px;align-items:center;padding:8px 10px;border-bottom:1px solid #26384f;background:#141d2a}",
            "#webhook{flex:1;background:#0d121b;color:#fff;border:1px solid #4a6d93;border-radius:3px;padding:5px;font:inherit}",
            "#log{flex:1;overflow:auto;white-space:pre-wrap;user-select:text;padding:8px 10px;line-height:1.45}",
            "#status{color:#8ea6c1;min-width:110px;text-align:right}",
            "</style></head><body>",
            "<div id='bar'><span id='title'>Xtoys Bridge MZ</span><button id='copy'>Copy All</button><button id='clear'>Clear</button><span id='status'>Connected</span></div>",
            "<div id='config'><label>Webhook ID</label><input id='webhook' value='" + escapedId + "'><button id='save'>Save</button></div>",
            "<div id='log'></div>",
            "<script>",
            "(function(){'use strict';var L=document.getElementById('log'),I=document.getElementById('webhook'),S=document.getElementById('status'),lines=[];",
            "function ok(){return window.opener&&!window.opener.closed&&window.opener.XtoysBridgeMZ}",
            "window.XtoysBridgeApp={appendLine:function(line){lines.push(line);var e=document.createElement('div');e.textContent=line;L.appendChild(e);L.scrollTop=L.scrollHeight}};",
            "document.getElementById('save').onclick=function(){if(ok()){window.opener.XtoysBridgeMZ.setWebhookId(I.value);S.textContent='Saved'}};",
            "document.getElementById('clear').onclick=function(){lines=[];L.textContent='';S.textContent='Cleared'};",
            "function fallback(text){var t=document.createElement('textarea');t.value=text;document.body.appendChild(t);t.select();document.execCommand('copy');document.body.removeChild(t)}",
            "function copyText(text,label){if(!text){S.textContent='Use Copy All or Ctrl+C';return}function done(){S.textContent=label||'Copied'};if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(done,function(){fallback(text);done()})}else{fallback(text);done()}}",
            "document.getElementById('copy').onclick=function(){copyText(lines.join('\\n'),'Copied')};",
            "document.addEventListener('contextmenu',function(e){e.preventDefault();copyText(String(window.getSelection?window.getSelection():''),'Selection copied')});",
            "(function(){var bar=document.getElementById('bar'),drag=false,sx=0,sy=0,wx=0,wy=0;bar.addEventListener('mousedown',function(e){if(e.button!==0)return;if(e.target.tagName==='BUTTON')return;drag=true;sx=e.screenX;sy=e.screenY;wx=window.screenX;wy=window.screenY;e.preventDefault()});document.addEventListener('mousemove',function(e){if(!drag)return;window.moveTo(wx+e.screenX-sx,wy+e.screenY-sy)});document.addEventListener('mouseup',function(e){if(!drag)return;drag=false;window.moveTo(wx+e.screenX-sx,wy+e.screenY-sy)})})();",
            "setInterval(function(){S.textContent=ok()?'Connected':'Disconnected'},1000);if(ok())window.opener.XtoysBridgeMZ.onPanelReady();})();",
            "<\/script></body></html>"
        ].join("");
    }

    function openPanel() {
        if (popupAlive()) {
            popup.focus();
            flushPopup();
            return true;
        }
        popup = window.open("", "xtoys_bridge_mz", "width=760,height=560,scrollbars=yes,resizable=yes");
        if (!popup) {
            log("WARN", "Panel popup blocked. Use the Bridge button.");
            return false;
        }
        popup.document.write(buildPanelHtml());
        popup.document.close();
        return true;
    }

    function createButton() {
        if (reopenButton || !document.body) return;
        reopenButton = document.createElement("button");
        reopenButton.textContent = "Bridge";
        reopenButton.title = "Open XToys bridge panel";
        reopenButton.style.cssText = [
            "position:absolute", "left:10px", "top:74px", "z-index:1000002",
            "padding:4px 8px", "background:rgba(25,95,135,0.9)", "color:#fff",
            "border:1px solid rgba(255,255,255,0.55)", "border-radius:4px",
            "font:12px sans-serif", "cursor:pointer", "pointer-events:auto"
        ].join(";");
        reopenButton.addEventListener("click", function(e) {
            e.stopPropagation();
            openPanel();
        });
        document.body.appendChild(reopenButton);
    }

    window.XtoysBridgeMZ = {
        setWebhookId: function(value) {
            webhookId = String(value || "").trim();
            log("CONFIG", "Webhook ID updated length=" + webhookId.length);
        },
        onPanelReady: function() {
            flushPopup();
        },
        open: openPanel
    };

    var _Game_Switches_setValue = Game_Switches.prototype.setValue;
    Game_Switches.prototype.setValue = function(switchId, value) {
        var oldValue = this.value(switchId);
        _Game_Switches_setValue.call(this, switchId, value);
        var newValue = this.value(switchId);
        if (oldValue !== newValue && !oldValue && newValue && partMap[switchId]) {
            sendHit(switchId);
        }
    };

    var _Game_Variables_setValue = Game_Variables.prototype.setValue;
    Game_Variables.prototype.setValue = function(variableId, value) {
        var oldValue = this.value(variableId);
        _Game_Variables_setValue.call(this, variableId, value);
        var newValue = this.value(variableId);
        if (oldValue === newValue) return;
        if (variableId === 29) sendEp(oldValue, newValue);
        if (variableId === 24) sendRestraint(oldValue, newValue);
        if (variableId === 112) sendClimax(oldValue, newValue);
    };

    var _Scene_Boot_start = Scene_Boot.prototype.start;
    Scene_Boot.prototype.start = function() {
        _Scene_Boot_start.call(this);
        initFileLog();
        createButton();
        log("READY", "XtoysBridgeMZ ready. Webhook configured=" + (!!webhookId));
        if (autoOpenPanel) setTimeout(openPanel, 500);
    };
})();
