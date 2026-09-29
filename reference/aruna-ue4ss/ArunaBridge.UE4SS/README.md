# XtoysArunaBridge

`XtoysArunaBridge` is a UE4SS Lua bridge for `Aruna and the Labyrinth of SealedLewd`.

It is separate from `XtoysArunaProbe`. The bridge reads only the fields confirmed safe by the probe:

- `BDValue`
- `OrgasmNum`
- `TotalOrgasmNum`
- `ShellOrgasmStrength`
- `EnergyOrgasmStrength`
- `ShellAlpha`
- `EnergyAlpha`
- `Core`

It does not read the widget fields that previously correlated with UE4SS native crashes.

## Install

1. Install UE4SS under:

```text
Aruna and the Labyrinth of SealedLewd1.206\ArunaLOSL\Binaries\Win64
```

2. Copy this folder:

```text
src\ArunaBridge.UE4SS\Mods\XtoysArunaBridge
```

to:

```text
Aruna and the Labyrinth of SealedLewd1.206\ArunaLOSL\Binaries\Win64\Mods\XtoysArunaBridge
```

3. Enable the mod in `Mods\mods.txt`:

```text
XtoysArunaBridge : 1
```

For ordinary bridge testing, disable `XtoysArunaProbe` so its hotkeys and polling do not overlap.

## Configure

The mod folder includes a default config:

```text
Mods\XtoysArunaBridge\xtoys_aruna_bridge_config.txt
```

Set:

```text
webhook=<your XToys webhook ID or full URL>
enabled=true
```

Then press `F6` in game to reload the config, or restart the game.

If a second config exists next to `ArunaLOSL-Win64-Shipping.exe`, that root config takes priority over the packaged mod config.

## Hotkeys

- `F6`: reload config.
- `F7`: toggle runtime dispatch without editing the file.
- `F8`: send a test payload.
- `F9`: reset runtime state.

## Payloads

Hit payloads are batched every `batchWindowMs` and include only the XToys-facing fields:

```json
{
  "action": "hit",
  "part": "breast",
  "intensity": 80,
  "orgasmDelta": 0.055000,
  "part1": null,
  "part2": "breast",
  "partWeight2": 1.0,
  "part3": "clit_penis",
  "partWeight3": 0.04
}
```

Slot order is:

```text
part1 = oral
part2 = breast
part3 = clit_penis
part4 = futanari
part5 = urethra
part6 = vagina
part7 = anus
```

Only the main part and up to `maxSecondaryParts` secondary parts are filled. Other `partN` and `partWeightN` fields are sent as `null`.
Secondary weights use a compression curve: `(partDelta / mainPartDelta) ^ secondaryWeightExponent`. The default exponent is `0.5`, so secondary parts are stronger than the old linear ratio while still preserving their relative order.
`orgasmDelta` is folded into the hit payload as the raw positive `OrgasmNum` delta observed in the batch. `0` means no orgasm delta.

## Logs

Main log:

```text
xtoys_aruna_bridge_log.txt
```

PowerShell POST errors, if any:

```text
xtoys_aruna_bridge_post_errors.log
```

Successful POSTs are queued through a small helper script and summarized as queued counts to avoid high-frequency log spam.
The Lua side writes payload files into `Mods\XtoysArunaBridge\payloads`; a single hidden PowerShell worker posts those files to XToys. It does not start a new PowerShell process for every payload.

`WG_Converter unavailable` logs are throttled by `unavailableLogIntervalMs` and also emit when availability changes.
