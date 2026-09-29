using DominatePlanBridge.Core;
using System;
using System.Collections;
using System.Collections.Generic;
using System.Reflection;
using System.Text;
using TMPro;
using UnityEngine.UI;

namespace DominatePlanBridge.BepInEx.Hooks;

internal static class ProbeSnapshot
{
    private const int MaxItems = 48;
    private const int MaxTextItems = 32;
    private static long _lastUiScanMs;

    internal static string Create(MethodBase method, object? instance, long nowMs)
    {
        var builder = new StringBuilder();
        var values = new List<string>();
        AppendCapturedFields(values, "self.", instance, 0, new List<object>());

        if (values.Count > 0)
        {
            builder.Append(" fields=");
            builder.Append(string.Join(";", values.ToArray()));
        }

        if (nowMs - _lastUiScanMs >= 1500)
        {
            _lastUiScanMs = nowMs;
            var texts = CaptureVisibleTexts();
            if (texts.Count > 0)
            {
                builder.Append(" texts=");
                builder.Append(string.Join(";", texts.ToArray()));
            }
        }

        if (builder.Length == 0)
        {
            return string.Empty;
        }

        var methodName = method.DeclaringType?.FullName + "." + method.Name;
        return methodName + builder;
    }

    private static void AppendCapturedFields(List<string> values, string prefix, object? instance, int depth, List<object> seen)
    {
        if (instance == null || depth > 2 || values.Count >= MaxItems)
        {
            return;
        }

        var type = instance.GetType();
        if (IsSimple(type))
        {
            return;
        }

        foreach (var existing in seen)
        {
            if (ReferenceEquals(existing, instance))
            {
                return;
            }
        }

        seen.Add(instance);

        foreach (var field in EnumerateFields(type))
        {
            if (values.Count >= MaxItems)
            {
                return;
            }

            object? value;
            try
            {
                value = field.GetValue(instance);
            }
            catch
            {
                continue;
            }

            if (IsOwnerPointer(field.Name))
            {
                AppendCapturedFields(values, "owner.", value, depth + 1, seen);
                continue;
            }

            if (ProbeNameFilter.ShouldCapture(field.Name))
            {
                if (value != null && !IsSimple(value.GetType()) && !(value is UnityEngine.Object))
                {
                    values.Add(prefix + field.Name + "=<" + value.GetType().Name + ">");
                    AppendCapturedFields(values, prefix + field.Name + ".", value, depth + 1, seen);
                }
                else
                {
                    values.Add(prefix + field.Name + "=" + FormatValue(value));
                }
            }
        }
    }

    private static IEnumerable<FieldInfo> EnumerateFields(Type type)
    {
        for (var current = type; current != null; current = current.BaseType)
        {
            var flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly;
            foreach (var field in current.GetFields(flags))
            {
                if (field.IsStatic)
                {
                    continue;
                }

                yield return field;
            }
        }
    }

    private static List<string> CaptureVisibleTexts()
    {
        var values = new List<string>();
        CaptureUnityTexts(values);
        CaptureTmpTexts(values);
        return values;
    }

    private static void CaptureUnityTexts(List<string> values)
    {
        try
        {
            foreach (var text in UnityEngine.Object.FindObjectsOfType<Text>())
            {
                if (values.Count >= MaxTextItems)
                {
                    return;
                }

                if (text != null && text.transform != null)
                {
                    TryAddText(values, text.name, GetPath(text.transform), text.text);
                }
            }
        }
        catch (Exception ex)
        {
            values.Add("UnityTextScanError=" + ex.GetType().Name);
        }
    }

    private static void CaptureTmpTexts(List<string> values)
    {
        try
        {
            foreach (var text in UnityEngine.Object.FindObjectsOfType<TMP_Text>())
            {
                if (values.Count >= MaxTextItems)
                {
                    return;
                }

                if (text != null && text.transform != null)
                {
                    TryAddText(values, text.name, GetPath(text.transform), text.text);
                }
            }
        }
        catch (Exception ex)
        {
            values.Add("TmpTextScanError=" + ex.GetType().Name);
        }
    }

    private static void TryAddText(List<string> values, string name, string path, string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return;
        }

        var compact = text!.Replace("\r", " ").Replace("\n", " ").Trim();
        if (compact.Length > 40)
        {
            compact = compact.Substring(0, 40) + "...";
        }

        var relevant = ProbeNameFilter.ShouldCapture(name)
            || ProbeNameFilter.ShouldCapture(path)
            || compact.IndexOf("%", StringComparison.Ordinal) >= 0
            || compact.IndexOf("口", StringComparison.Ordinal) >= 0
            || compact.IndexOf("胸", StringComparison.Ordinal) >= 0
            || compact.IndexOf("下", StringComparison.Ordinal) >= 0
            || compact.IndexOf("尻", StringComparison.Ordinal) >= 0;

        if (!relevant)
        {
            return;
        }

        values.Add(Sanitize(path) + "='" + Sanitize(compact) + "'");
    }

    private static string GetPath(UnityEngine.Transform transform)
    {
        var names = new Stack<string>();
        for (var current = transform; current != null; current = current.parent)
        {
            names.Push(current.name);
            if (names.Count >= 5)
            {
                break;
            }
        }

        return string.Join("/", names.ToArray());
    }

    private static bool IsOwnerPointer(string name)
    {
        return name == "<>4__this" || name.EndsWith("__this", StringComparison.Ordinal);
    }

    private static bool IsSimple(Type type)
    {
        return type.IsPrimitive || type.IsEnum || type == typeof(string) || type == typeof(decimal);
    }

    private static string FormatValue(object? value)
    {
        if (value == null)
        {
            return "null";
        }

        if (value is string text)
        {
            return "'" + Sanitize(text) + "'";
        }

        if (value is UnityEngine.Object unityObject)
        {
            return "<" + value.GetType().Name + ":" + Sanitize(unityObject.name) + ">";
        }

        if (value is IEnumerable enumerable && !(value is string))
        {
            var count = 0;
            foreach (var _ in enumerable)
            {
                count++;
                if (count > 999)
                {
                    break;
                }
            }

            return "<" + value.GetType().Name + " count=" + count + ">";
        }

        return Sanitize(Convert.ToString(value) ?? string.Empty);
    }

    private static string Sanitize(string value)
    {
        return value.Replace("\r", " ").Replace("\n", " ").Replace(";", ",").Replace("'", "\"");
    }
}



