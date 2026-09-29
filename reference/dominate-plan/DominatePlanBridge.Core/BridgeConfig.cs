using System;

namespace DominatePlanBridge.Core;

public sealed class BridgeConfig
{
    public BridgeConfig(int hitCooldownMs = 120, int climaxLockMs = 8000)
    {
        HitCooldownMs = Math.Max(0, hitCooldownMs);
        ClimaxLockMs = Math.Max(0, climaxLockMs);
    }

    public int HitCooldownMs { get; }

    public int ClimaxLockMs { get; }
}
