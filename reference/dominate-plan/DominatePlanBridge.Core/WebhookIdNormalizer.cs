using System;

namespace DominatePlanBridge.Core;

public static class WebhookIdNormalizer
{
    public static string Normalize(string? value)
    {
        var trimmed = (value ?? string.Empty).Trim();
        if (trimmed.Length == 0)
        {
            return string.Empty;
        }

        if (Uri.TryCreate(trimmed, UriKind.Absolute, out var uri) &&
            string.Equals(uri.Host, "webhook.xtoys.app", StringComparison.OrdinalIgnoreCase))
        {
            return uri.AbsolutePath.Trim('/').Split('/')[0].Trim();
        }

        return trimmed.Trim('/');
    }
}
