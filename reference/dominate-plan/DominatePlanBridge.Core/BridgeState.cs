using System.Collections.Generic;

namespace DominatePlanBridge.Core;

public sealed class BridgeState
{
    private readonly BridgeConfig _config;
    private readonly Dictionary<string, long> _lastHitAt = new();
    private long _lastClimaxAt = long.MinValue;
    private string _lastPart = "unknown";

    public BridgeState(BridgeConfig config)
    {
        _config = config;
    }

    public WebhookPayload? TryHit(string sourceName, long nowMs)
    {
        var part = PartMapper.FromSourceName(sourceName);
        if (part == null)
        {
            return null;
        }

        if (_lastHitAt.TryGetValue(sourceName, out var lastAt) &&
            nowMs - lastAt < _config.HitCooldownMs)
        {
            return null;
        }

        _lastHitAt[sourceName] = nowMs;
        _lastPart = part;
        return WebhookPayload.Hit(part);
    }

    public WebhookPayload? TryEp(int oldValue, int newValue)
    {
        if (newValue <= oldValue)
        {
            return null;
        }

        return WebhookPayload.Ep(_lastPart, newValue - oldValue, newValue);
    }

    public WebhookPayload? TryClimax(int oldValue, int newValue, long nowMs)
    {
        if (newValue <= oldValue)
        {
            return null;
        }

        if (_lastClimaxAt != long.MinValue &&
            nowMs - _lastClimaxAt < _config.ClimaxLockMs)
        {
            return null;
        }

        _lastClimaxAt = nowMs;
        return WebhookPayload.Climax(_lastPart, newValue);
    }
}
