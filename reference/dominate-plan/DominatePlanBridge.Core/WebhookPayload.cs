using System.Globalization;
using System.Text;

namespace DominatePlanBridge.Core;

public sealed class WebhookPayload
{
    private WebhookPayload(
        string action,
        string? part = null,
        int? epGain = null,
        int? epStock = null,
        int? climaxCount = null,
        int? partValue = null,
        decimal? partPercent = null,
        bool batched = false,
        int? windowMs = null,
        HitBatchSlot? part1 = null,
        HitBatchSlot? part2 = null,
        HitBatchSlot? part3 = null,
        HitBatchSlot? part4 = null)
    {
        Action = action;
        Part = part;
        EpGain = epGain;
        EpStock = epStock;
        ClimaxCount = climaxCount;
        PartValue = partValue;
        PartPercent = partPercent;
        Batched = batched;
        WindowMs = windowMs;
        Part1 = part1;
        Part2 = part2;
        Part3 = part3;
        Part4 = part4;
    }

    public string Action { get; }

    public string? Part { get; }

    public int? EpGain { get; }

    public int? EpStock { get; }

    public int? ClimaxCount { get; }

    public int? PartValue { get; }

    public decimal? PartPercent { get; }

    public bool Batched { get; }

    public int? WindowMs { get; }

    public HitBatchSlot? Part1 { get; }

    public HitBatchSlot? Part2 { get; }

    public HitBatchSlot? Part3 { get; }

    public HitBatchSlot? Part4 { get; }

    public static WebhookPayload Hit(string part)
    {
        return new WebhookPayload("hit", part: part);
    }

    public static WebhookPayload HitWithMetrics(string part, int? partValue, decimal? partPercent)
    {
        return new WebhookPayload("hit", part: part, partValue: partValue, partPercent: partPercent);
    }

    public static WebhookPayload BatchedHit(int windowMs, HitBatchSlot part1, HitBatchSlot part2, HitBatchSlot part3, HitBatchSlot part4)
    {
        return new WebhookPayload(
            "hit",
            batched: true,
            windowMs: windowMs,
            part1: part1,
            part2: part2,
            part3: part3,
            part4: part4);
    }

    public static WebhookPayload Ep(string part, int epGain, int epStock)
    {
        return new WebhookPayload("ep", part: part, epGain: epGain, epStock: epStock);
    }

    public static WebhookPayload Climax(string part, int climaxCount)
    {
        return new WebhookPayload("climax", part: part, climaxCount: climaxCount);
    }

    public string ToJson()
    {
        var builder = new StringBuilder();
        builder.Append('{');
        AppendString(builder, "action", Action, first: true);

        if (Batched)
        {
            AppendBool(builder, "batched", true);
            AppendNumber(builder, "windowMs", WindowMs ?? 0);
            AppendSlot(builder, 1, Part1 ?? HitBatchSlot.Empty);
            AppendSlot(builder, 2, Part2 ?? HitBatchSlot.Empty);
            AppendSlot(builder, 3, Part3 ?? HitBatchSlot.Empty);
            AppendSlot(builder, 4, Part4 ?? HitBatchSlot.Empty);
            builder.Append('}');
            return builder.ToString();
        }

        if (Part != null)
        {
            AppendString(builder, "part", Part, first: false);
        }

        if (PartValue.HasValue)
        {
            AppendNumber(builder, "partValue", PartValue.Value);
        }

        if (PartPercent.HasValue)
        {
            AppendDecimal(builder, "partPercent", PartPercent.Value);
        }

        if (EpGain.HasValue)
        {
            AppendNumber(builder, "epGain", EpGain.Value);
        }

        if (EpStock.HasValue)
        {
            AppendNumber(builder, "epStock", EpStock.Value);
        }

        if (ClimaxCount.HasValue)
        {
            AppendNumber(builder, "climaxCount", ClimaxCount.Value);
        }

        builder.Append('}');
        return builder.ToString();
    }

    private static void AppendSlot(StringBuilder builder, int index, HitBatchSlot slot)
    {
        AppendNullableString(builder, "part" + index, slot.Part);
        AppendNullableNumber(builder, "partValue" + index, slot.PartValue);
        AppendNullableDecimal(builder, "partPercent" + index, slot.PartPercent);
    }

    private static void AppendString(StringBuilder builder, string name, string value, bool first)
    {
        if (!first)
        {
            builder.Append(',');
        }

        builder.Append('"').Append(name).Append("\":\"").Append(Escape(value)).Append('"');
    }

    private static void AppendNullableString(StringBuilder builder, string name, string? value)
    {
        builder.Append(',').Append('"').Append(name).Append("\":");
        if (value == null)
        {
            builder.Append("null");
            return;
        }

        builder.Append('"').Append(Escape(value)).Append('"');
    }

    private static void AppendNumber(StringBuilder builder, string name, int value)
    {
        builder.Append(',').Append('"').Append(name).Append("\":").Append(value);
    }

    private static void AppendNullableNumber(StringBuilder builder, string name, int? value)
    {
        builder.Append(',').Append('"').Append(name).Append("\":");
        if (value.HasValue)
        {
            builder.Append(value.Value);
        }
        else
        {
            builder.Append("null");
        }
    }

    private static void AppendDecimal(StringBuilder builder, string name, decimal value)
    {
        builder.Append(',').Append('"').Append(name).Append("\":").Append(value.ToString("0.###", CultureInfo.InvariantCulture));
    }

    private static void AppendNullableDecimal(StringBuilder builder, string name, decimal? value)
    {
        builder.Append(',').Append('"').Append(name).Append("\":");
        if (value.HasValue)
        {
            builder.Append(value.Value.ToString("0.###", CultureInfo.InvariantCulture));
        }
        else
        {
            builder.Append("null");
        }
    }

    private static void AppendBool(StringBuilder builder, string name, bool value)
    {
        builder.Append(',').Append('"').Append(name).Append("\":").Append(value ? "true" : "false");
    }

    private static string Escape(string value)
    {
        return value.Replace("\\", "\\\\").Replace("\"", "\\\"");
    }
}