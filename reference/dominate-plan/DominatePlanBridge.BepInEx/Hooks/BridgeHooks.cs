using DominatePlanBridge.Core;
using System;
using System.Reflection;
using TMPro;

namespace DominatePlanBridge.BepInEx.Hooks;

internal static class BridgeHooks
{
    private static Plugin? _plugin;

    internal static void Initialize(Plugin plugin)
    {
        _plugin = plugin;
    }

    internal static void Postfix(MethodBase __originalMethod, object? __instance)
    {
        var plugin = _plugin;
        if (plugin == null || __instance == null)
        {
            return;
        }

        var source = (__originalMethod.DeclaringType?.Name ?? "unknown") + "." + __originalMethod.Name;
        var part = PartMapper.FromSourceName(source);
        if (part == null)
        {
            return;
        }

        var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var hit = plugin.State.TryHit(source, nowMs);
        if (hit != null)
        {
            plugin.QueueHit(
                part,
                ReadCurrentPartValue(__instance, part),
                ReadCurrentPartPercent(part),
                nowMs);
        }

        var climax = TryBuildClimax(plugin, __instance, nowMs);
        if (climax != null)
        {
            plugin.FlushPendingHitBatch();
            plugin.WebhookClient.Dispatch(climax);
        }
    }

    private static WebhookPayload? TryBuildClimax(Plugin plugin, object instance, long nowMs)
    {
        var orgNowField = instance.GetType().GetField("OrgNow", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        var raw = orgNowField?.GetValue(instance);
        var orgNow = raw is float f ? f : raw is double d ? (float)d : 0f;
        if (orgNow < 1f)
        {
            return null;
        }

        return plugin.TryClimax(nowMs);
    }

    private static int? ReadCurrentPartValue(object instance, string part)
    {
        var fieldName = part == "mouth" ? "KuchiSt" :
            part == "chest" ? "MuneSt" :
            part == "lower" ? "KabuSt" :
            part == "butt" ? "KethuSt" : null;

        if (fieldName == null)
        {
            return null;
        }

        var field = instance.GetType().GetField(fieldName, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        var raw = field?.GetValue(instance) as string;
        return int.TryParse(raw, out var value) ? value : null;
    }

    private static decimal? ReadCurrentPartPercent(string part)
    {
        var marker = part == "mouth" ? "Ku_H/Num" :
            part == "chest" ? "Mu_H/Num" :
            part == "lower" ? "Ka_H/Num" :
            part == "butt" ? "Ke_H/Num" : null;

        if (marker == null)
        {
            return null;
        }

        try
        {
            foreach (var text in UnityEngine.Object.FindObjectsOfType<TMP_Text>())
            {
                if (text == null || text.transform == null)
                {
                    continue;
                }

                var path = GetPath(text.transform);
                if (path.IndexOf(marker, StringComparison.Ordinal) < 0)
                {
                    continue;
                }

                var raw = (text.text ?? string.Empty).Replace("%", string.Empty).Trim();
                if (decimal.TryParse(raw, System.Globalization.NumberStyles.Number, System.Globalization.CultureInfo.InvariantCulture, out var percent))
                {
                    return percent;
                }
            }
        }
        catch
        {
            return null;
        }

        return null;
    }

    private static string GetPath(UnityEngine.Transform transform)
    {
        var names = new System.Collections.Generic.Stack<string>();
        for (var current = transform; current != null; current = current.parent)
        {
            names.Push(current.name);
            if (names.Count >= 6)
            {
                break;
            }
        }

        return string.Join("/", names.ToArray());
    }
}

