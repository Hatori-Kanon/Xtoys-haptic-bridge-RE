using DominatePlanBridge.Core;
using System;
using System.Net;
using System.Text;
using System.Threading.Tasks;

namespace DominatePlanBridge.BepInEx;

internal sealed class WebhookClient
{
    private const long PostSummaryIntervalMs = 5000;

    private readonly Plugin _plugin;
    private readonly object _sync = new object();
    private readonly PostStatusAggregator _postStatusAggregator = new PostStatusAggregator(PostSummaryIntervalMs);
    private string _webhookId = string.Empty;
    private bool _enabled;
    private string _lastStatus = "Not configured.";

    internal WebhookClient(Plugin plugin, string webhookId, bool enabled)
    {
        _plugin = plugin;
        UpdateSettings(webhookId, enabled);
    }

    internal string LastStatus
    {
        get
        {
            lock (_sync)
            {
                return _lastStatus;
            }
        }
    }

    internal bool IsReady
    {
        get
        {
            lock (_sync)
            {
                return _enabled && _webhookId.Length > 0;
            }
        }
    }

    internal void UpdateSettings(string webhookId, bool enabled)
    {
        var normalized = WebhookIdNormalizer.Normalize(webhookId);
        lock (_sync)
        {
            _webhookId = normalized;
            _enabled = enabled && normalized.Length > 0;
            _lastStatus = _enabled ? "Webhook ready." : "Dispatch disabled or webhook ID missing.";
        }
    }

    internal void Dispatch(WebhookPayload payload)
    {
        var json = payload.ToJson();
        _plugin.Log("PAYLOAD", json);
        DispatchJson(json);
    }

    internal void DispatchTest()
    {
        const string json = "{\"action\":\"test\",\"source\":\"dominate_plan_bridge\"}";
        _plugin.Log("TEST_PAYLOAD", json);
        DispatchJson(json);
    }

    private void DispatchJson(string json)
    {
        var webhookId = GetActiveWebhookId();
        if (webhookId == null)
        {
            return;
        }

        Task.Run(() => PostAsync(webhookId, json));
    }

    private string? GetActiveWebhookId()
    {
        lock (_sync)
        {
            return _enabled && _webhookId.Length > 0 ? _webhookId : null;
        }
    }

    private async Task PostAsync(string webhookId, string json)
    {
        try
        {
            var request = (HttpWebRequest)WebRequest.Create("https://webhook.xtoys.app/" + webhookId);
            request.Method = "POST";
            request.ContentType = "application/json";

            var bytes = Encoding.UTF8.GetBytes(json);
            using (var stream = await request.GetRequestStreamAsync())
            {
                await stream.WriteAsync(bytes, 0, bytes.Length);
            }

            using (var response = (HttpWebResponse)await request.GetResponseAsync())
            {
                var status = ((int)response.StatusCode).ToString();
                SetLastStatus("POST " + status);
                if (status == "200")
                {
                    LogPostSuccessSummary(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                }
                else
                {
                    _plugin.Log("POST", status);
                }
            }
        }
        catch (Exception ex)
        {
            var status = ex.GetType().Name + " " + ex.Message;
            SetLastStatus(status);
            _plugin.Log("POST_ERROR", status);
        }
    }

    private void LogPostSuccessSummary(long nowMs)
    {
        int? count;
        lock (_sync)
        {
            count = _postStatusAggregator.RecordSuccess(nowMs);
        }

        if (count != null)
        {
            _plugin.Log("POST", "200 x" + count.Value + " in 5s");
        }
    }

    private void SetLastStatus(string status)
    {
        lock (_sync)
        {
            _lastStatus = status;
        }
    }
}