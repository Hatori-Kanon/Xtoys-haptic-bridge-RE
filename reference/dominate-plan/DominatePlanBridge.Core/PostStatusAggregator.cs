using System;

namespace DominatePlanBridge.Core;

public sealed class PostStatusAggregator
{
    private readonly long _intervalMs;
    private int _pendingSuccesses;
    private long _windowStartMs = -1;

    public PostStatusAggregator(long intervalMs)
    {
        _intervalMs = Math.Max(1, intervalMs);
    }

    public int? RecordSuccess(long nowMs)
    {
        if (_pendingSuccesses == 0)
        {
            _windowStartMs = nowMs;
        }

        _pendingSuccesses++;
        return FlushDue(nowMs);
    }

    public int? FlushDue(long nowMs)
    {
        if (_pendingSuccesses == 0 || _windowStartMs < 0 || nowMs - _windowStartMs < _intervalMs)
        {
            return null;
        }

        return Flush();
    }

    public int? Flush()
    {
        if (_pendingSuccesses == 0)
        {
            return null;
        }

        var count = _pendingSuccesses;
        _pendingSuccesses = 0;
        _windowStartMs = -1;
        return count;
    }
}
