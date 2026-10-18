// ═══════════════════════════════════════════════════════════════════
//  mpp2xml — MS Project (.mpp / .mpx / .mpt) → MSPDI XML converter
// ═══════════════════════════════════════════════════════════════════
//  Free, local, no cloud. Wraps the open-source MPXJ library
//  (https://github.com/joniles/mpxj, nuget net.sf.mpxj — .NET via IKVM,
//  so NO Java runtime is required). Shelled out by the ARAD Bulk Daemon
//  (arad_driver_worker.py → cmd_convert_mpp) to feed TOWER's schedule
//  import (tower-parse-schedule-xml, which consumes MSPDI XML).
//
//  Usage:  mpp2xml <input.mpp> <output.xml>
//  Exit:   0 ok · 1 exception · 2 bad args · 3 could-not-read
// ═══════════════════════════════════════════════════════════════════

using System;
using net.sf.mpxj.reader;
using net.sf.mpxj.mspdi;

class Program
{
    static int Main(string[] args)
    {
        if (args.Length < 2)
        {
            Console.Error.WriteLine("usage: mpp2xml <input.mpp> <output.xml>");
            return 2;
        }
        var inputPath = args[0];
        var outputPath = args[1];
        try
        {
            // UniversalProjectReader auto-detects MPP/MPX/MPT/MSPDI/XER/etc.
            var project = new UniversalProjectReader().read(inputPath);
            if (project == null)
            {
                Console.Error.WriteLine("could not read project file (unsupported / corrupt)");
                return 3;
            }
            // Always emit MSPDI XML regardless of the output extension.
            new MSPDIWriter().write(project, outputPath);
            return 0;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine(e.Message);
            return 1;
        }
    }
}
