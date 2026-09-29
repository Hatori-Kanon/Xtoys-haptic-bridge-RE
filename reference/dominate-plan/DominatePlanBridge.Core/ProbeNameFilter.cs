using System;

namespace DominatePlanBridge.Core;

public static class ProbeNameFilter
{
    private static readonly string[] IncludeFragments =
    {
        "kuchi", "mouth", "kuch",
        "mune", "boob", "breast",
        "kabu", "under", "lower",
        "kethu", "keth", "ketu", "butt",
        "higyaku", "maso",
        "yogore", "osen",
        "orgasm", "org", "zech",
        "kando", "kanjiru", "inran",
        "energy", "ene"
    };

    public static bool ShouldCapture(string? name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return false;
        }

        var candidate = name!;
        if (candidate.StartsWith("<>", StringComparison.Ordinal) || candidate.IndexOf("__", StringComparison.Ordinal) >= 0)
        {
            return false;
        }

        var lowerName = candidate.ToLowerInvariant();
        foreach (var fragment in IncludeFragments)
        {
            if (lowerName.IndexOf(fragment, StringComparison.Ordinal) >= 0)
            {
                return true;
            }
        }

        return false;
    }
}
