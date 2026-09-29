using HarmonyLib;
using System;
using System.Collections.Generic;
using System.Reflection;

namespace DominatePlanBridge.BepInEx.Hooks;

internal static class ProbeHooks
{
    private static readonly Dictionary<string, long> LastEntryLogMs = new Dictionary<string, long>();
    private static readonly Dictionary<string, long> LastSnapshotLogMs = new Dictionary<string, long>();
    private static Action<string, string>? _log;

    internal static void Initialize(Action<string, string> log)
    {
        _log = log;
    }

    internal static void Prefix(MethodBase __originalMethod, object? __instance, object[] __args)
    {
        var log = _log;
        if (log == null)
        {
            return;
        }

        var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var methodName = GetMethodName(__originalMethod);
        if (!ShouldLog(LastEntryLogMs, methodName, nowMs, 400))
        {
            return;
        }

        var instanceName = __instance == null ? "static" : __instance.GetType().FullName;
        log("PROBE", $"{methodName} instance={instanceName} args={__args.Length}");
    }

    internal static void Postfix(MethodBase __originalMethod, object? __instance, object[] __args)
    {
        var log = _log;
        if (log == null)
        {
            return;
        }

        var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var methodName = GetMethodName(__originalMethod);
        if (!ShouldLog(LastSnapshotLogMs, methodName, nowMs, 700))
        {
            return;
        }

        try
        {
            var snapshot = ProbeSnapshot.Create(__originalMethod, __instance, nowMs);
            if (!string.IsNullOrWhiteSpace(snapshot))
            {
                log("SNAP", snapshot);
            }
        }
        catch (Exception ex)
        {
            log("ERROR", $"snapshot failed {methodName}: {ex.GetType().Name} {ex.Message}");
        }
    }

    private static bool ShouldLog(Dictionary<string, long> lastLogs, string key, long nowMs, long intervalMs)
    {
        if (lastLogs.TryGetValue(key, out var lastMs) && nowMs - lastMs < intervalMs)
        {
            return false;
        }

        lastLogs[key] = nowMs;
        return true;
    }

    private static string GetMethodName(MethodBase method)
    {
        return (method.DeclaringType?.FullName ?? "unknown") + "." + method.Name;
    }
}