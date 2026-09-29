local BRIDGE_VERSION = "0.1.1"
local MOD_NAME = "XtoysArunaBridge"
local LOG_FILE = "xtoys_aruna_bridge_log.txt"
local CONFIG_FILE = "xtoys_aruna_bridge_config.txt"
local WORKER_SCRIPT_FILE = "Mods/XtoysArunaBridge/xtoys_worker.ps1"
local WORKER_LAUNCHER_FILE = "Mods/XtoysArunaBridge/xtoys_worker.vbs"
local WORKER_CONFIG_FILE = "Mods/XtoysArunaBridge/xtoys_worker_config.txt"
local PAYLOAD_DIR = "Mods/XtoysArunaBridge/payloads"

local DEFAULT_CONFIG = {
    webhook = "",
    enabled = false,
    sampleIntervalMs = 100,
    batchWindowMs = 250,
    quietWindowMs = 1200,
    postSummaryMs = 5000,
    minDelta = 0.000001,
    minDominantRatio = 0.35,
    maxDeltaForIntensity = 0.012,
    strengthFullScale = 1.0,
    minIntensity = 8,
    maxIntensity = 100,
    secondaryPartMinWeight = 0.02,
    secondaryWeightExponent = 0.5,
    maxSecondaryParts = 3,
    unavailableLogIntervalMs = 5000,
    logPayloads = true,
    logSamples = false,
}

local PARTS = {
    { index = 1, key = "oral", label = "口腔" },
    { index = 2, key = "breast", label = "乳房" },
    { index = 3, key = "clit_penis", label = "クリトリスペニス" },
    { index = 4, key = "futanari", label = "フタナリ" },
    { index = 5, key = "urethra", label = "尿道" },
    { index = 6, key = "vagina", label = "膣" },
    { index = 7, key = "anus", label = "肛門" },
}

local WATCHED_FIELDS = {
    "OrgasmNum",
    "TotalOrgasmNum",
    "ShellOrgasmStrength",
    "EnergyOrgasmStrength",
    "ShellAlpha",
    "EnergyAlpha",
    "Core",
}

local KIND_READY = "READY"
local KIND_CONFIG = "CONFIG"
local KIND_ERROR = "ERROR"
local KIND_HOTKEY = "HOTKEY"
local KIND_SAMPLE = "SAMPLE"
local KIND_PAYLOAD = "PAYLOAD"
local KIND_POST = "POST"
local KIND_STATE = "STATE"

local config = {}
local logPath = nil
local initialized = false
local tickScheduled = false
local bridgeClockMs = 0
local lastSample = nil
local lastActivityMs = 0
local batch = nil
local postSequence = 0
local postSuccessCount = 0
local postLastSummaryMs = 0
local dispatchEnabledRuntime = false
local lastConverterName = ""
local converterAvailable = false
local converterUnavailableLogged = false
local lastUnavailableLogMs = -999999
local workerStarted = false

local unpackArgs = table.unpack or unpack

local function nowText()
    return os.date("%H:%M:%S")
end

local function nowMs()
    return bridgeClockMs
end

local function uniqueFileStamp()
    return (os.time() * 1000) + postSequence
end

local function safeToString(value)
    local ok, result = pcall(function()
        if value == nil then
            return "nil"
        end
        return tostring(value)
    end)
    if ok then
        return result
    end
    return "<tostring failed>"
end

local function appendFile(path, line)
    local file = io.open(path, "a")
    if file == nil then
        return false
    end
    file:write(line)
    file:write("\n")
    file:close()
    return true
end

local function writeFile(path, text)
    local file = io.open(path, "w")
    if file == nil then
        return false
    end
    file:write(text)
    file:close()
    return true
end

local function resetFile(path)
    local file = io.open(path, "w")
    if file == nil then
        return false
    end
    file:close()
    return true
end

local function chooseLogPath()
    if logPath ~= nil then
        return logPath
    end

    if resetFile(LOG_FILE) then
        logPath = LOG_FILE
        return logPath
    end

    logPath = "Mods/XtoysArunaBridge/" .. LOG_FILE
    resetFile(logPath)
    return logPath
end

local function logLine(kind, message)
    local line = string.format("[%s] [%s] %s", nowText(), kind, message)
    if not appendFile(chooseLogPath(), line) then
        print("[XtoysArunaBridge] " .. line)
    end
end

local function trim(value)
    value = safeToString(value)
    value = string.gsub(value, "^%s+", "")
    value = string.gsub(value, "%s+$", "")
    return value
end

local function lower(value)
    return string.lower(safeToString(value))
end

local function parseBool(value, fallback)
    local text = lower(trim(value))
    if text == "1" or text == "true" or text == "yes" or text == "on" or text == "enabled" then
        return true
    end
    if text == "0" or text == "false" or text == "no" or text == "off" or text == "disabled" then
        return false
    end
    return fallback
end

local function parseNumber(value, fallback)
    local number = tonumber(trim(value))
    if number == nil then
        return fallback
    end
    return number
end

local function normalizeWebhook(value)
    local text = trim(value)
    if text == "" then
        return ""
    end

    text = string.gsub(text, "%?.*$", "")
    text = string.gsub(text, "/+$", "")

    local prefix = "https://webhook.xtoys.app/"
    if string.sub(lower(text), 1, string.len(prefix)) == prefix then
        text = string.sub(text, string.len(prefix) + 1)
    end

    text = string.gsub(text, "^/+", "")
    local slash = string.find(text, "/", 1, true)
    if slash ~= nil then
        text = string.sub(text, 1, slash - 1)
    end
    text = string.gsub(text, "[^%w_%-]", "")
    return trim(text)
end

local function configText()
    return table.concat({
        "# XtoysArunaBridge config",
        "# Accepts either a bare webhook ID or https://webhook.xtoys.app/<id>",
        "webhook=",
        "enabled=false",
        "sampleIntervalMs=100",
        "batchWindowMs=250",
        "quietWindowMs=1200",
        "postSummaryMs=5000",
        "minDelta=0.000001",
        "minDominantRatio=0.35",
        "maxDeltaForIntensity=0.012",
        "strengthFullScale=1.0",
        "minIntensity=8",
        "maxIntensity=100",
        "secondaryPartMinWeight=0.02",
        "secondaryWeightExponent=0.5",
        "maxSecondaryParts=3",
        "unavailableLogIntervalMs=5000",
        "logPayloads=true",
        "logSamples=false",
        "",
    }, "\n")
end

local function ensureDefaultConfig()
    local file = io.open(CONFIG_FILE, "r")
    if file ~= nil then
        file:close()
        return
    end

    local fallback = "Mods/XtoysArunaBridge/" .. CONFIG_FILE
    file = io.open(fallback, "r")
    if file ~= nil then
        file:close()
        logLine(KIND_CONFIG, "using packaged config path=" .. fallback)
        return
    end

    if writeFile(CONFIG_FILE, configText()) then
        logLine(KIND_CONFIG, "created default config path=" .. CONFIG_FILE)
    else
        if writeFile(fallback, configText()) then
            logLine(KIND_CONFIG, "created default config path=" .. fallback)
        else
            logLine(KIND_ERROR, "failed to create default config")
        end
    end
end

local function readConfigFile()
    local file = io.open(CONFIG_FILE, "r")
    local path = CONFIG_FILE
    if file == nil then
        path = "Mods/XtoysArunaBridge/" .. CONFIG_FILE
        file = io.open(path, "r")
    end

    local values = {}
    if file ~= nil then
        for line in file:lines() do
            local clean = string.gsub(line, "#.*$", "")
            local key, value = string.match(clean, "^%s*([%w_]+)%s*=%s*(.-)%s*$")
            if key ~= nil then
                values[key] = value
            end
        end
        file:close()
    end

    local nextConfig = {}
    for key, value in pairs(DEFAULT_CONFIG) do
        nextConfig[key] = value
    end

    nextConfig.webhook = normalizeWebhook(values.webhook or nextConfig.webhook)
    nextConfig.enabled = parseBool(values.enabled, nextConfig.enabled)
    nextConfig.sampleIntervalMs = math.max(50, math.floor(parseNumber(values.sampleIntervalMs, nextConfig.sampleIntervalMs)))
    nextConfig.batchWindowMs = math.max(100, math.floor(parseNumber(values.batchWindowMs, nextConfig.batchWindowMs)))
    nextConfig.quietWindowMs = math.max(100, math.floor(parseNumber(values.quietWindowMs, nextConfig.quietWindowMs)))
    nextConfig.postSummaryMs = math.max(1000, math.floor(parseNumber(values.postSummaryMs, nextConfig.postSummaryMs)))
    nextConfig.minDelta = parseNumber(values.minDelta, nextConfig.minDelta)
    nextConfig.minDominantRatio = parseNumber(values.minDominantRatio, nextConfig.minDominantRatio)
    nextConfig.maxDeltaForIntensity = parseNumber(values.maxDeltaForIntensity, nextConfig.maxDeltaForIntensity)
    nextConfig.strengthFullScale = math.max(0.001, parseNumber(values.strengthFullScale, nextConfig.strengthFullScale))
    nextConfig.minIntensity = math.max(0, math.floor(parseNumber(values.minIntensity, nextConfig.minIntensity)))
    nextConfig.maxIntensity = math.min(100, math.max(nextConfig.minIntensity, math.floor(parseNumber(values.maxIntensity, nextConfig.maxIntensity))))
    nextConfig.secondaryPartMinWeight = math.max(0, parseNumber(values.secondaryPartMinWeight, nextConfig.secondaryPartMinWeight))
    nextConfig.secondaryWeightExponent = math.max(0.01, parseNumber(values.secondaryWeightExponent, nextConfig.secondaryWeightExponent))
    nextConfig.maxSecondaryParts = math.max(0, math.floor(parseNumber(values.maxSecondaryParts, nextConfig.maxSecondaryParts)))
    nextConfig.unavailableLogIntervalMs = math.max(1000, math.floor(parseNumber(values.unavailableLogIntervalMs, nextConfig.unavailableLogIntervalMs)))
    nextConfig.logPayloads = parseBool(values.logPayloads, nextConfig.logPayloads)
    nextConfig.logSamples = parseBool(values.logSamples, nextConfig.logSamples)

    config = nextConfig
    dispatchEnabledRuntime = config.enabled

    logLine(
        KIND_CONFIG,
        "loaded path=" .. path ..
        " enabled=" .. tostring(config.enabled) ..
        " webhookConfigured=" .. tostring(config.webhook ~= "") ..
        " sampleIntervalMs=" .. tostring(config.sampleIntervalMs) ..
        " batchWindowMs=" .. tostring(config.batchWindowMs)
    )
end

local function ensurePayloadDir()
    local probePath = PAYLOAD_DIR .. "/.keep"
    local file = io.open(probePath, "a")
    if file ~= nil then
        file:close()
        return true
    end

    logLine(KIND_ERROR, "payload directory unavailable path=" .. PAYLOAD_DIR)
    return false
end

local function writeWorkerConfig()
    local text = table.concat({
        "webhook=" .. config.webhook,
        "enabled=" .. tostring(dispatchEnabledRuntime and config.webhook ~= ""),
        "",
    }, "\r\n")

    if not writeFile(WORKER_CONFIG_FILE, text) then
        logLine(KIND_ERROR, "failed to write worker config path=" .. WORKER_CONFIG_FILE)
    end
end

local function ensureWorkerScripts()
    local script = table.concat({
        "$ErrorActionPreference = 'Stop'",
        "$root = Split-Path -Parent $MyInvocation.MyCommand.Path",
        "$queue = Join-Path $root 'payloads'",
        "$config = Join-Path $root 'xtoys_worker_config.txt'",
        "$errors = Join-Path $root 'xtoys_aruna_bridge_post_errors.log'",
        "$mutexCreated = $false",
        "$mutex = New-Object System.Threading.Mutex($false, 'Global\\XtoysArunaBridgeWorker', [ref]$mutexCreated)",
        "if (-not $mutexCreated) { exit 0 }",
        "New-Item -ItemType Directory -Force -Path $queue | Out-Null",
        "function Read-BridgeConfig {",
        "    $result = @{ webhook = ''; enabled = 'false' }",
        "    if (Test-Path -LiteralPath $config) {",
        "        foreach ($line in Get-Content -LiteralPath $config -ErrorAction SilentlyContinue) {",
        "            if ($line -match '^\\s*([^#=]+)\\s*=\\s*(.*?)\\s*$') {",
        "                $key = $matches[1].Trim()",
        "                $value = $matches[2].Trim()",
        "                $result[$key] = $value",
        "            }",
        "        }",
        "    }",
        "    return $result",
        "}",
        "try {",
        "    while ($true) {",
        "        $cfg = Read-BridgeConfig",
        "        $enabled = $cfg.enabled -eq 'true'",
        "        $webhook = $cfg.webhook",
        "        if ($enabled -and -not [string]::IsNullOrWhiteSpace($webhook)) {",
        "            $files = Get-ChildItem -LiteralPath $queue -Filter 'payload_*.json' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -First 20",
        "            foreach ($file in $files) {",
        "                try {",
        "                    $json = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8",
        "                    Invoke-RestMethod -Method Post -Uri ('https://webhook.xtoys.app/' + $webhook) -Body $json -ContentType 'application/json' -TimeoutSec 5 | Out-Null",
        "                    Remove-Item -LiteralPath $file.FullName -ErrorAction SilentlyContinue",
        "                } catch {",
        "                    Add-Content -LiteralPath $errors -Value ('[' + (Get-Date -Format 'HH:mm:ss') + '] ' + $_.Exception.GetType().Name + ' ' + $_.Exception.Message)",
        "                    Start-Sleep -Milliseconds 1000",
        "                    break",
        "                }",
        "            }",
        "        }",
        "        Start-Sleep -Milliseconds 150",
        "    }",
        "} finally {",
        "    $mutex.ReleaseMutex() | Out-Null",
        "    $mutex.Dispose()",
        "}",
        "",
    }, "\r\n")

    if not writeFile(WORKER_SCRIPT_FILE, script) then
        logLine(KIND_ERROR, "failed to write worker script path=" .. WORKER_SCRIPT_FILE)
    end

    local launcher = table.concat({
        "Set shell = CreateObject(\"WScript.Shell\")",
        "shell.Run \"powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"\"Mods\\XtoysArunaBridge\\xtoys_worker.ps1\"\"\", 0, False",
        "",
    }, "\r\n")

    if not writeFile(WORKER_LAUNCHER_FILE, launcher) then
        logLine(KIND_ERROR, "failed to write worker launcher path=" .. WORKER_LAUNCHER_FILE)
    end
end

local function startWorker()
    if workerStarted then
        return
    end

    workerStarted = true
    os.execute('wscript.exe "' .. WORKER_LAUNCHER_FILE .. '"')
    logLine(KIND_POST, "hidden worker launch requested")
end

local function callMethod(object, methodName)
    if object == nil then
        return nil
    end

    local ok, result = pcall(function()
        local member = object[methodName]
        if type(member) == "function" then
            return member(object)
        end
        return nil
    end)

    if ok then
        return result
    end
    return nil
end

local function callGlobal(functionName, ...)
    local fn = _G[functionName]
    if type(fn) ~= "function" then
        return false, nil
    end

    local args = {...}
    local ok, result = pcall(function()
        return fn(unpackArgs(args))
    end)
    return ok, result
end

local function isValidObject(object)
    if object == nil then
        return false
    end

    local valid = callMethod(object, "IsValid")
    if valid == false then
        return false
    end
    return true
end

local function objectName(object)
    if not isValidObject(object) then
        return "<invalid>"
    end
    return safeToString(callMethod(object, "GetFullName") or callMethod(object, "GetName") or object)
end

local function safeGetField(object, fieldName)
    if object == nil then
        return false, nil
    end

    local ok, result = pcall(function()
        return object[fieldName]
    end)
    return ok, result
end

local function unwrapValue(value)
    if value == nil then
        return nil
    end

    local ok, result = pcall(function()
        local getter = value.get
        if type(getter) == "function" then
            return getter(value)
        end
        return value
    end)

    if ok then
        return result
    end
    return value
end

local function valueText(value)
    value = unwrapValue(value)
    if value == nil then
        return "nil"
    end
    if type(value) == "number" or type(value) == "boolean" or type(value) == "string" then
        return safeToString(value)
    end
    local text = callMethod(value, "ToString")
    if text ~= nil then
        return safeToString(text)
    end
    local percent = callMethod(value, "GetPercent")
    if percent ~= nil then
        return safeToString(percent)
    end
    return safeToString(value)
end

local function numberField(object, fieldName)
    local ok, value = safeGetField(object, fieldName)
    if not ok then
        return nil
    end

    value = unwrapValue(value)
    if type(value) == "number" then
        return value
    end

    local percent = callMethod(value, "GetPercent")
    if type(percent) == "number" then
        return percent
    end
    return tonumber(valueText(value))
end

local function arrayCount(value)
    local count = callMethod(value, "GetArrayNum")
    if count ~= nil then
        return tonumber(count)
    end
    return nil
end

local function readArrayNumbers(object, fieldName)
    local ok, value = safeGetField(object, fieldName)
    if not ok then
        return nil
    end

    value = unwrapValue(value)
    local count = arrayCount(value)
    if count == nil then
        return nil
    end

    local values = {}
    local iterOk = pcall(function()
        value:ForEach(function(index, element)
            if index >= 1 and index <= 16 then
                values[index] = tonumber(valueText(element))
            end
        end)
    end)

    if not iterOk then
        return nil
    end
    return values
end

local function converterScore(object)
    local score = 0
    local bd = readArrayNumbers(object, "BDValue")
    if bd ~= nil then
        for _, part in ipairs(PARTS) do
            local value = bd[part.index] or 0
            score = score + math.abs(value) * 1000
        end
    end

    for _, fieldName in ipairs(WATCHED_FIELDS) do
        local value = numberField(object, fieldName)
        if value ~= nil then
            if fieldName == "Core" then
                score = score + math.abs(50000 - value) / 1000
            else
                score = score + math.abs(value)
            end
        end
    end
    return score
end

local function findActiveConverter()
    local ok, objects = pcall(function()
        return FindAllOf("WG_Converter_C")
    end)

    if not ok or objects == nil then
        return nil, 0, 0, "FindAllOf failed"
    end

    local selected = nil
    local selectedIndex = 0
    local selectedScore = -1
    local count = 0
    for index, object in ipairs(objects) do
        count = count + 1
        if isValidObject(object) then
            local score = converterScore(object)
            if score >= selectedScore then
                selected = object
                selectedIndex = index
                selectedScore = score
            end
        end
    end
    return selected, selectedIndex, count, selectedScore
end

local function readSample(object, instanceIndex)
    local bd = readArrayNumbers(object, "BDValue")
    if bd == nil then
        return nil, "BDValue unavailable"
    end

    return {
        instanceIndex = instanceIndex,
        objectName = objectName(object),
        bd = bd,
        orgasm = numberField(object, "OrgasmNum") or 0,
        totalOrgasm = numberField(object, "TotalOrgasmNum") or 0,
        shellStrength = numberField(object, "ShellOrgasmStrength") or 0,
        energyStrength = numberField(object, "EnergyOrgasmStrength") or 0,
        shellAlpha = numberField(object, "ShellAlpha") or 0,
        energyAlpha = numberField(object, "EnergyAlpha") or 0,
        core = numberField(object, "Core"),
    }, nil
end

local function clamp(value, minValue, maxValue)
    if value < minValue then
        return minValue
    end
    if value > maxValue then
        return maxValue
    end
    return value
end

local function round(value)
    return math.floor(value + 0.5)
end

local function computeIntensity(delta, strength)
    local deltaScore = clamp(delta / math.max(config.maxDeltaForIntensity, 0.000001), 0, 1)
    local strengthScore = clamp(strength / config.strengthFullScale, 0, 1)
    local score = math.max(deltaScore, strengthScore)
    local value = config.minIntensity + (config.maxIntensity - config.minIntensity) * score
    return clamp(round(value), config.minIntensity, config.maxIntensity)
end

local function analyzeDelta(previous, current)
    local totalDelta = 0
    local maxDelta = 0
    local dominant = nil
    local slots = {}

    for _, part in ipairs(PARTS) do
        local currentValue = current.bd[part.index] or 0
        local previousValue = previous.bd[part.index] or currentValue
        local delta = currentValue - previousValue
        if delta < 0 then
            delta = 0
        end

        totalDelta = totalDelta + delta
        if delta > maxDelta then
            maxDelta = delta
            dominant = part
        end

        table.insert(slots, {
            part = part,
            value = currentValue,
            delta = delta,
        })
    end

    if dominant == nil or maxDelta < config.minDelta then
        return nil
    end

    local ratio = 1.0
    if totalDelta > 0 then
        ratio = maxDelta / totalDelta
    end
    if ratio < config.minDominantRatio then
        dominant = { key = "mixed", label = "mixed", index = 0 }
    end

    local strength = math.max(current.shellStrength or 0, current.energyStrength or 0)
    return {
        dominant = dominant,
        maxDelta = maxDelta,
        totalDelta = totalDelta,
        dominantRatio = ratio,
        intensity = computeIntensity(maxDelta, strength),
        strength = strength,
        slots = slots,
    }
end

local function jsonEscape(value)
    value = safeToString(value)
    value = string.gsub(value, "\\", "\\\\")
    value = string.gsub(value, '"', '\\"')
    value = string.gsub(value, "\r", "\\r")
    value = string.gsub(value, "\n", "\\n")
    return value
end

local function jsonString(value)
    if value == nil then
        return "null"
    end
    return '"' .. jsonEscape(value) .. '"'
end

local function jsonNumber(value, precision)
    if value == nil then
        return "null"
    end
    if precision ~= nil then
        return string.format("%." .. tostring(precision) .. "f", value)
    end
    return safeToString(value)
end

local function appendJsonField(parts, name, encodedValue)
    table.insert(parts, '"' .. name .. '":' .. encodedValue)
end

local function buildHitPayload(batchToSend)
    local maxSlotDelta = 0
    local totalSlotDelta = 0
    local mainSlot = nil
    local weightedSlots = {}

    for _, slot in ipairs(batchToSend.slots) do
        local delta = slot.delta or 0
        totalSlotDelta = totalSlotDelta + delta
        if delta > maxSlotDelta then
            maxSlotDelta = delta
            mainSlot = slot
        end
    end

    local topPart = nil
    if mainSlot ~= nil and maxSlotDelta >= config.minDelta then
        local dominantRatio = 1
        if totalSlotDelta > 0 then
            dominantRatio = maxSlotDelta / totalSlotDelta
        end

        if dominantRatio < config.minDominantRatio then
            topPart = "mixed"
        else
            topPart = mainSlot.part.key
        end

        for _, slot in ipairs(batchToSend.slots) do
            if (slot.delta or 0) >= config.minDelta then
                local weight = slot.delta / maxSlotDelta
                if slot ~= mainSlot then
                    weight = weight ^ config.secondaryWeightExponent
                end
                table.insert(weightedSlots, {
                    part = slot.part,
                    weight = weight,
                    isMain = slot == mainSlot,
                })
            end
        end

        table.sort(weightedSlots, function(a, b)
            if a.isMain ~= b.isMain then
                return a.isMain
            end
            if a.weight ~= b.weight then
                return a.weight > b.weight
            end
            return a.part.index < b.part.index
        end)
    end

    local activeByIndex = {}
    local secondaryCount = 0
    for _, slot in ipairs(weightedSlots) do
        if slot.isMain then
            activeByIndex[slot.part.index] = slot.weight
        elseif secondaryCount < config.maxSecondaryParts and slot.weight >= config.secondaryPartMinWeight then
            activeByIndex[slot.part.index] = slot.weight
            secondaryCount = secondaryCount + 1
        end
    end

    local fields = {}
    appendJsonField(fields, "action", jsonString("hit"))
    appendJsonField(fields, "part", jsonString(topPart))
    appendJsonField(fields, "intensity", jsonNumber(batchToSend.intensity))
    appendJsonField(fields, "orgasmDelta", jsonNumber(batchToSend.orgasmDelta or 0, 6))

    for index, slot in ipairs(batchToSend.slots) do
        local weight = activeByIndex[slot.part.index]
        appendJsonField(fields, "part" .. tostring(index), weight ~= nil and jsonString(slot.part.key) or "null")
        appendJsonField(fields, "partWeight" .. tostring(index), weight ~= nil and jsonNumber(weight, 4) or "null")
    end

    return "{" .. table.concat(fields, ",") .. "}"
end

local function buildTestPayload()
    return '{"action":"test","version":"' .. BRIDGE_VERSION .. '"}'
end

local function logPostSummary(force)
    local now = nowMs()
    if postSuccessCount <= 0 then
        return
    end
    if force or (now - postLastSummaryMs) >= config.postSummaryMs then
        logLine(KIND_POST, "queued x" .. tostring(postSuccessCount) .. " in " .. tostring(config.postSummaryMs) .. "ms")
        postSuccessCount = 0
        postLastSummaryMs = now
    end
end

local function dispatchJson(json, tag)
    if config.logPayloads then
        logLine(tag or KIND_PAYLOAD, json)
    end

    if not dispatchEnabledRuntime or config.webhook == "" then
        return
    end

    if not ensurePayloadDir() then
        return
    end
    writeWorkerConfig()
    startWorker()
    postSequence = postSequence + 1
    local payloadPath = string.format("%s/payload_%d_%d.json", PAYLOAD_DIR, uniqueFileStamp(), postSequence)
    if not writeFile(payloadPath, json) then
        logLine(KIND_ERROR, "failed to write payload path=" .. payloadPath)
        return
    end

    postSuccessCount = postSuccessCount + 1
    logPostSummary(false)
end

local function startBatch(analysis, current, now)
    batch = {
        startMs = now,
        lastMs = now,
        intensity = analysis.intensity,
        orgasmDelta = 0,
        slots = analysis.slots,
    }
end

local function emptySlots()
    local slots = {}
    for _, part in ipairs(PARTS) do
        table.insert(slots, {
            part = part,
            value = nil,
            delta = 0,
        })
    end
    return slots
end

local function startOrgasmOnlyBatch(now, orgasmDelta)
    batch = {
        startMs = now,
        lastMs = now,
        intensity = 0,
        orgasmDelta = orgasmDelta,
        slots = emptySlots(),
    }
end

local function mergeBatch(analysis, current, now)
    if batch == nil then
        startBatch(analysis, current, now)
        return
    end

    batch.lastMs = now
    batch.intensity = math.max(batch.intensity, analysis.intensity)

    for index, slot in ipairs(analysis.slots) do
        local target = batch.slots[index]
        if target ~= nil then
            target.value = slot.value
            target.delta = (target.delta or 0) + (slot.delta or 0)
        end
    end
end

local function flushBatch(reason)
    if batch == nil then
        return
    end

    local payload = buildHitPayload(batch)
    batch = nil
    dispatchJson(payload, KIND_PAYLOAD)
    if reason ~= nil then
        logLine(KIND_STATE, "flushed batch reason=" .. reason)
    end
end

local function handleSample(current)
    local now = nowMs()
    if lastSample == nil or lastSample.objectName ~= current.objectName then
        lastSample = current
        lastConverterName = current.objectName
        logLine(KIND_STATE, "active converter instance=" .. tostring(current.instanceIndex) .. " object=" .. current.objectName)
        return
    end

    local analysis = analyzeDelta(lastSample, current)
    local deltaOrgasm = (current.orgasm or 0) - (lastSample.orgasm or 0)
    if deltaOrgasm < 0 then
        deltaOrgasm = 0
    end

    if analysis ~= nil then
        lastActivityMs = now
        mergeBatch(analysis, current, now)
    elseif deltaOrgasm > 0 and batch == nil then
        startOrgasmOnlyBatch(now, deltaOrgasm)
        lastActivityMs = now
    end

    if deltaOrgasm > 0 and batch ~= nil then
        batch.orgasmDelta = math.max(batch.orgasmDelta or 0, deltaOrgasm)
        lastActivityMs = now
    end

    if analysis ~= nil and config.logSamples then
        logLine(
            KIND_SAMPLE,
            "part=" .. analysis.dominant.key ..
            " intensity=" .. tostring(analysis.intensity) ..
            " maxDelta=" .. string.format("%.9f", analysis.maxDelta) ..
            " totalDelta=" .. string.format("%.9f", analysis.totalDelta) ..
            " strength=" .. string.format("%.6f", analysis.strength)
        )
    end

    if batch ~= nil and (now - batch.startMs) >= config.batchWindowMs then
        flushBatch("window")
    end

    if batch ~= nil and (now - lastActivityMs) >= config.quietWindowMs then
        flushBatch("quiet")
    end

    lastSample = current
end

local function tick()
    tickScheduled = false
    bridgeClockMs = bridgeClockMs + config.sampleIntervalMs

    local object, instanceIndex, count, score = findActiveConverter()
    if object == nil then
        local now = nowMs()
        if initialized and (not converterUnavailableLogged or converterAvailable or (now - lastUnavailableLogMs) >= config.unavailableLogIntervalMs) then
            logLine(KIND_SAMPLE, "WG_Converter unavailable count=" .. tostring(count) .. " score=" .. safeToString(score))
            lastUnavailableLogMs = now
            converterUnavailableLogged = true
        end
        converterAvailable = false
        lastSample = nil
    else
        if not converterAvailable then
            logLine(KIND_SAMPLE, "WG_Converter available count=" .. tostring(count) .. " selectedInstance=" .. tostring(instanceIndex))
        end
        converterAvailable = true
        converterUnavailableLogged = false
        local sample, err = readSample(object, instanceIndex)
        if sample ~= nil then
            handleSample(sample)
        else
            logLine(KIND_SAMPLE, "sample unavailable err=" .. safeToString(err))
        end
    end

    logPostSummary(false)

    if type(ExecuteWithDelay) == "function" then
        tickScheduled = true
        ExecuteWithDelay(config.sampleIntervalMs, tick)
    else
        logLine(KIND_ERROR, "ExecuteWithDelay unavailable; bridge polling stopped")
    end
end

local function reloadConfig()
    readConfigFile()
    writeWorkerConfig()
    if dispatchEnabledRuntime and config.webhook ~= "" then
        startWorker()
    end
    logLine(KIND_STATE, "runtime dispatch=" .. tostring(dispatchEnabledRuntime))
end

local function toggleDispatch()
    dispatchEnabledRuntime = not dispatchEnabledRuntime
    writeWorkerConfig()
    if dispatchEnabledRuntime and config.webhook ~= "" then
        startWorker()
    end
    logLine(KIND_STATE, "runtime dispatch toggled=" .. tostring(dispatchEnabledRuntime) .. " webhookConfigured=" .. tostring(config.webhook ~= ""))
end

local function sendTest()
    dispatchJson(buildTestPayload(), "TEST_PAYLOAD")
end

local function registerHotkey(keyCode, label, callback)
    local ok, err = pcall(function()
        if type(RegisterKeyBindAsync) == "function" then
            RegisterKeyBindAsync(keyCode, {}, function()
                logLine(KIND_HOTKEY, label)
                callback()
            end)
        else
            RegisterKeyBind(keyCode, {}, function()
                logLine(KIND_HOTKEY, label)
                callback()
            end)
        end
    end)

    if ok then
        logLine(KIND_HOTKEY, label .. " registered")
    else
        logLine(KIND_ERROR, "RegisterKeyBind failed for " .. label .. ": " .. safeToString(err))
    end
end

local function resetRuntime()
    batch = nil
    lastSample = nil
    lastActivityMs = 0
    postSuccessCount = 0
    postLastSummaryMs = nowMs()
    lastConverterName = ""
    converterAvailable = false
    converterUnavailableLogged = false
    lastUnavailableLogMs = -999999
    logLine(KIND_STATE, "runtime state reset")
end

local function startBridge()
    chooseLogPath()
    ensureDefaultConfig()
    ensurePayloadDir()
    ensureWorkerScripts()
    readConfigFile()
    writeWorkerConfig()
    if dispatchEnabledRuntime and config.webhook ~= "" then
        startWorker()
    end
    resetRuntime()

    initialized = true
    logLine(KIND_READY, "Xtoys Aruna Bridge ready version=" .. BRIDGE_VERSION .. " log=" .. chooseLogPath())
    logLine(KIND_READY, "F6 reloads config, F7 toggles runtime dispatch, F8 sends test payload, F9 resets runtime state")
    logLine(KIND_READY, "safe fields: BDValue, OrgasmNum, TotalOrgasmNum, ShellOrgasmStrength, EnergyOrgasmStrength, ShellAlpha, EnergyAlpha, Core")

    registerHotkey(Key.F6, "F6 reload bridge config", reloadConfig)
    registerHotkey(Key.F7, "F7 toggle bridge dispatch", toggleDispatch)
    registerHotkey(Key.F8, "F8 send bridge test", sendTest)
    registerHotkey(Key.F9, "F9 reset bridge runtime", resetRuntime)

    if not tickScheduled then
        tickScheduled = true
        ExecuteWithDelay(config.sampleIntervalMs, tick)
    end
end

startBridge()
