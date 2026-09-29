using System;
using System.Collections.Generic;

namespace DominatePlanBridge.Core;

public static class PartMapper
{
    private static readonly Dictionary<string, string> SourceToPart = new(StringComparer.OrdinalIgnoreCase)
    {
        ["KuchiPlus"] = "mouth",
        ["MunePlus"] = "chest",
        ["KabuPlus"] = "lower",
        ["KethuPlus"] = "butt",
        ["HigyakuPlus"] = "abuse"
    };

    public static string? FromSourceName(string sourceName)
    {
        var normalized = sourceName;
        var lastDot = normalized.LastIndexOf('.');
        if (lastDot >= 0 && lastDot + 1 < normalized.Length)
        {
            normalized = normalized.Substring(lastDot + 1);
        }

        return SourceToPart.TryGetValue(normalized, out var part) ? part : null;
    }
}
