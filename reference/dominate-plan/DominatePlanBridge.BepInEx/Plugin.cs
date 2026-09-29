using BepInEx;
using BepInEx.Configuration;
using DominatePlanBridge.BepInEx.Hooks;
using DominatePlanBridge.Core;
using HarmonyLib;
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using UnityEngine;

namespace DominatePlanBridge.BepInEx;

[BepInPlugin(PluginGuid, PluginName, PluginVersion)]
public sealed class Plugin : BaseUnityPlugin
{
    public const string PluginGuid = "local.xtoys.dominateplan.bridge";
    public const string PluginName = "XToys Dominate Plan Bridge";
    public const string PluginVersion = "0.2.0";

    private readonly HashSet<MethodBase> _bridgePatchedMethods = new HashSet<MethodBase>();
    private Harmony? _harmony;
    private BridgeState? _state;
    private WebhookClient? _webhookClient;
    private HitBatcher? _hitBatcher;
    private ConfigEntry<string>? _webhookIdConfig;
    private ConfigEntry<bool>? _enableDispatchConfig;
    private string _bridgeLogPath = string.Empty;
    private int _lastClimaxCount;
    private bool _settingsVisible;
    private Rect _settingsWindow = new Rect(60f, 60f, 520f, 235f);
    private string _settingsWebhookId = string.Empty;
    private bool _settingsEnableDispatch;
    private string _settingsMessage = "Enter webhook ID, enable dispatch, then Save.";

    internal static Plugin? Instance { get; private set; }

    internal BridgeState State => _state ?? throw new InvalidOperationException("Bridge state is not initialized.");

    internal WebhookClient WebhookClient => _webhookClient ?? throw new InvalidOperationException("Webhook client is not initialized.");

    private ConfigEntry<string> WebhookIdConfig => _webhookIdConfig ?? throw new InvalidOperationException("Webhook ID config is not initialized.");

    private ConfigEntry<bool> EnableDispatchConfig => _enableDispatchConfig ?? throw new InvalidOperationException("Dispatch config is not initialized.");

    private void Awake()
    {
        Instance = this;
        _bridgeLogPath = Path.Combine(Paths.GameRootPath, "xtoys_dominate_bridge_log.txt");
        ResetBridgeLog();

        _webhookIdConfig = Config.Bind("XToys", "WebhookId", string.Empty, "XToys webhook ID. You can paste either the bare ID or the full https://webhook.xtoys.app/<id> URL.");
        _enableDispatchConfig = Config.Bind("XToys", "EnableDispatch", false, "When false, logs payloads but does not POST to XToys.");
        var hitCooldownMs = Config.Bind("Timing", "HitCooldownMs", 50, "Suppress duplicate hit events from the same source inside this short window.");
        var climaxDuplicateWindowMs = Config.Bind("Timing", "ClimaxDuplicateWindowMs", 1000, "Suppress duplicate climax events only. This does not suppress hits.");
        var batchWindowMs = Config.Bind("Timing", "BatchWindowMs", 200, "Merge hit events into one fixed-slot webhook payload during this window.");

        _state = new BridgeState(new BridgeConfig(hitCooldownMs.Value, climaxDuplicateWindowMs.Value));
        _hitBatcher = new HitBatcher(batchWindowMs.Value);
        _webhookClient = new WebhookClient(this, _webhookIdConfig.Value, _enableDispatchConfig.Value);
        ResetSettingsDraft();
        _harmony = new Harmony(PluginGuid);

        BridgeHooks.Initialize(this);
        HookBridgeCandidates();

        Log("READY", $"Xtoys Dominate Plan Bridge ready. dispatch={_enableDispatchConfig.Value} webhook configured={!string.IsNullOrWhiteSpace(WebhookIdNormalizer.Normalize(_webhookIdConfig.Value))}");
    }

    private void Update()
    {
        if (Input.GetKeyDown(KeyCode.F8))
        {
            _settingsVisible = !_settingsVisible;
            if (_settingsVisible)
            {
                ResetSettingsDraft();
            }
        }

        FlushPendingHitBatchDue(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    }

    private void OnDestroy()
    {
        FlushPendingHitBatch();
    }

    private void OnGUI()
    {
        if (!_settingsVisible || _webhookClient == null)
        {
            return;
        }

        _settingsWindow = GUI.Window(869420, _settingsWindow, DrawSettingsWindow, "XToys Bridge");
    }

    private void DrawSettingsWindow(int windowId)
    {
        GUILayout.Label("Webhook ID or full webhook URL");
        GUI.SetNextControlName("XtoysWebhookId");
        _settingsWebhookId = GUILayout.TextField(_settingsWebhookId ?? string.Empty, GUILayout.MinWidth(470f));
        _settingsEnableDispatch = GUILayout.Toggle(_settingsEnableDispatch, "Enable Dispatch");

        GUILayout.Space(6f);
        GUILayout.BeginHorizontal();
        if (GUILayout.Button("Save", GUILayout.Width(100f)))
        {
            SaveSettings();
        }

        if (GUILayout.Button("Test", GUILayout.Width(100f)))
        {
            if (SaveSettings())
            {
                WebhookClient.DispatchTest();
                _settingsMessage = "Test payload queued. Last status will update after POST.";
            }
        }

        if (GUILayout.Button("Close", GUILayout.Width(100f)))
        {
            _settingsVisible = false;
        }
        GUILayout.EndHorizontal();

        GUILayout.Space(6f);
        GUILayout.Label("Ready: " + (WebhookClient.IsReady ? "yes" : "no"));
        GUILayout.Label("Status: " + WebhookClient.LastStatus);
        GUILayout.Label(_settingsMessage);
        GUILayout.Label("F8 toggles this panel.");

        GUI.DragWindow(new Rect(0f, 0f, 10000f, 22f));
    }

    private void ResetSettingsDraft()
    {
        if (_webhookIdConfig == null || _enableDispatchConfig == null)
        {
            return;
        }

        _settingsWebhookId = WebhookIdNormalizer.Normalize(_webhookIdConfig.Value);
        _settingsEnableDispatch = _enableDispatchConfig.Value;
        _settingsMessage = "Enter webhook ID, enable dispatch, then Save.";
    }

    private bool SaveSettings()
    {
        var normalized = WebhookIdNormalizer.Normalize(_settingsWebhookId);
        _settingsWebhookId = normalized;
        WebhookIdConfig.Value = normalized;
        EnableDispatchConfig.Value = _settingsEnableDispatch;
        Config.Save();
        WebhookClient.UpdateSettings(normalized, _settingsEnableDispatch);

        var ready = WebhookClient.IsReady;
        _settingsMessage = ready ? "Saved. Dispatch is enabled." : "Saved. Dispatch is disabled or webhook ID is empty.";
        Log("CONFIG", $"webhook saved dispatch={_settingsEnableDispatch} configured={normalized.Length > 0}");
        return ready;
    }

    internal void QueueHit(string part, int? partValue, decimal? partPercent, long nowMs)
    {
        var batcher = _hitBatcher ?? throw new InvalidOperationException("Hit batcher is not initialized.");
        var due = batcher.AddHit(part, partValue, partPercent, nowMs);
        if (due != null)
        {
            WebhookClient.Dispatch(due);
        }
    }

    internal void FlushPendingHitBatchDue(long nowMs)
    {
        var due = _hitBatcher?.FlushDue(nowMs);
        if (due != null)
        {
            WebhookClient.Dispatch(due);
        }
    }

    internal void FlushPendingHitBatch()
    {
        var payload = _hitBatcher?.Flush();
        if (payload != null)
        {
            WebhookClient.Dispatch(payload);
        }
    }

    internal WebhookPayload? TryClimax(long nowMs)
    {
        var nextCount = _lastClimaxCount + 1;
        var payload = State.TryClimax(_lastClimaxCount, nextCount, nowMs);
        if (payload != null)
        {
            _lastClimaxCount = nextCount;
        }

        return payload;
    }

    private void HookBridgeCandidates()
    {
        PatchBridgeMethod("BattleStatus", "KuchiPlus");
        PatchBridgeMethod("BattleStatus", "MunePlus");
        PatchBridgeMethod("BattleStatus", "KabuPlus");
        PatchBridgeMethod("BattleStatus", "KethuPlus");
    }

    private void PatchBridgeMethod(string typeName, string methodName)
    {
        var method = FindMethod(typeName, methodName);
        if (method == null)
        {
            return;
        }

        PatchBridge(method, $"{typeName}.{methodName}");
    }

    private MethodInfo? FindMethod(string typeName, string methodName)
    {
        var type = AccessTools.TypeByName(typeName);
        if (type == null)
        {
            Log("MISS", $"type not found {typeName}");
            return null;
        }

        var method = AccessTools.Method(type, methodName);
        if (method == null)
        {
            Log("MISS", $"method not found {typeName}.{methodName}");
            return null;
        }

        return method;
    }

    private void PatchBridge(MethodBase method, string label)
    {
        if (_bridgePatchedMethods.Contains(method))
        {
            return;
        }

        try
        {
            var postfix = new HarmonyMethod(typeof(BridgeHooks).GetMethod(nameof(BridgeHooks.Postfix), BindingFlags.Static | BindingFlags.NonPublic));
            _harmony!.Patch(method, postfix: postfix);
            _bridgePatchedMethods.Add(method);
            Log("HOOK", "bridge " + label);
        }
        catch (Exception ex)
        {
            Log("ERROR", $"failed bridge hook {label}: {ex.GetType().Name} {ex.Message}");
        }
    }

    private void ResetBridgeLog()
    {
        try
        {
            File.WriteAllText(_bridgeLogPath, string.Empty);
        }
        catch (Exception ex)
        {
            Logger.LogWarning($"bridge file reset failed: {ex.Message}");
        }
    }

    internal void Log(string kind, string message)
    {
        var line = $"[{DateTime.Now:HH:mm:ss.fff}] [{kind}] {message}";
        Logger.LogInfo(line);

        try
        {
            File.AppendAllText(_bridgeLogPath, line + Environment.NewLine);
        }
        catch (Exception ex)
        {
            Logger.LogWarning($"bridge file log failed: {ex.Message}");
        }
    }
}