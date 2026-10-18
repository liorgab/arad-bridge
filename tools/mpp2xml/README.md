# mpp2xml — MS Project (.mpp) → MSPDI XML converter

Free, local, no cloud. Wraps the open-source **MPXJ** library
([joniles/mpxj](https://github.com/joniles/mpxj), nuget `net.sf.mpxj`, .NET via
IKVM — **no Java runtime required**). The ARAD Bulk Daemon shells out to
`mpp2xml.exe` (worker `cmd_convert_mpp`) to convert a binary `.mpp` into MSPDI
XML, which TOWER's schedule import (`tower-parse-schedule-xml`) already parses.

```
mpp2xml <input.mpp> <output.xml>
```
Exit codes: `0` ok · `1` exception · `2` bad args · `3` unreadable file.

---

## Build (one-time, on a machine with the .NET 8 SDK)

```powershell
cd arad-bridge\tools\mpp2xml
dotnet publish -c Release
# output: bin\Release\net8.0\win-x64\publish\   (mpp2xml.exe + IKVM/MPXJ dlls)
```
The publish folder is **self-contained** — it runs on any win-x64 machine
without a .NET or Java install.

## Install onto the daemon machine

Copy the entire `publish\` folder's contents into the daemon directory
`%LOCALAPPDATA%\AradBulkDaemon\` (so `mpp2xml.exe` sits beside
`chromedriver.exe`). Or run the helper:

```powershell
# from the build machine, after `dotnet publish`:
powershell -ExecutionPolicy Bypass -File .\install_mpp2xml.ps1
```

The worker resolves the tool at `%LOCALAPPDATA%\AradBulkDaemon\mpp2xml.exe`
(override via `config.json` key `mpp2xml_path`). No daemon restart is needed —
`cmd_convert_mpp` checks the path per call.

## Verify

```powershell
& "$env:LOCALAPPDATA\AradBulkDaemon\mpp2xml.exe" C:\path\to\plan.mpp C:\temp\plan.xml
# → creates plan.xml (MSPDI). In TOWER: project → "לוז" → "ייבוא לוז" → the .mpp
#   from the library → the schedule loads.
```

## Java fallback (if you prefer not to build .NET)

MPXJ also ships a Java `MpxjConvert`:
`java -jar mpxj.jar in.mpp out.xml`. To use it, wrap it so the worker can invoke
a single executable at `mpp2xml_path` (the worker runs it as `exe in out`, no
shell). The .NET self-contained exe above is the recommended path.
