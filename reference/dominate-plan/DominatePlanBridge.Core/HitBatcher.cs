using System;

namespace DominatePlanBridge.Core;

public sealed class HitBatcher
{
    private HitBatchSlot? _mouth;
    private HitBatchSlot? _chest;
    private HitBatchSlot? _lower;
    private HitBatchSlot? _butt;
    private long _windowStartMs = -1;

    public HitBatcher(int windowMs)
    {
        WindowMs = Math.Max(1, windowMs);
    }

    public int WindowMs { get; }

    public WebhookPayload? AddHit(string part, int? partValue, decimal? partPercent, long nowMs)
    {
        var due = FlushDue(nowMs);
        if (!HasPending)
        {
            _windowStartMs = nowMs;
        }

        SetSlot(part, new HitBatchSlot(part, partValue, partPercent));
        return due;
    }

    public WebhookPayload? FlushDue(long nowMs)
    {
        if (!HasPending || _windowStartMs < 0 || nowMs - _windowStartMs < WindowMs)
        {
            return null;
        }

        return Flush();
    }

    public WebhookPayload? Flush()
    {
        if (!HasPending)
        {
            return null;
        }

        var payload = WebhookPayload.BatchedHit(
            WindowMs,
            _mouth ?? HitBatchSlot.Empty,
            _chest ?? HitBatchSlot.Empty,
            _lower ?? HitBatchSlot.Empty,
            _butt ?? HitBatchSlot.Empty);
        Clear();
        return payload;
    }

    private bool HasPending => _mouth != null || _chest != null || _lower != null || _butt != null;

    private void SetSlot(string part, HitBatchSlot slot)
    {
        if (part == "mouth")
        {
            _mouth = slot;
        }
        else if (part == "chest")
        {
            _chest = slot;
        }
        else if (part == "lower")
        {
            _lower = slot;
        }
        else if (part == "butt")
        {
            _butt = slot;
        }
    }

    private void Clear()
    {
        _mouth = null;
        _chest = null;
        _lower = null;
        _butt = null;
        _windowStartMs = -1;
    }
}
