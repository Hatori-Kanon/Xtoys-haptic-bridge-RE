namespace DominatePlanBridge.Core;

public sealed class HitBatchSlot
{
    public static readonly HitBatchSlot Empty = new HitBatchSlot(null, null, null);

    public HitBatchSlot(string? part, int? partValue, decimal? partPercent)
    {
        Part = part;
        PartValue = partValue;
        PartPercent = partPercent;
    }

    public string? Part { get; }

    public int? PartValue { get; }

    public decimal? PartPercent { get; }
}
