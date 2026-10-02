using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;
using System.Runtime.InteropServices;
// Windows GUI subsystem: neither this host nor its PowerShell child owns a console.
internal static class NoWindowHost {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool SetInformationJobObject(IntPtr job, int kind, ref JobLimits limits, uint length);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters { public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)]
    private struct JobLimits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    private static string Quote(string value) {
        if (value.IndexOfAny(new char[] {'"', '\r', '\n'}) >= 0) throw new ArgumentException();
        return "\"" + value.TrimEnd('\\') + "\"";
    }
    [STAThread]
    private static int Main(string[] args) {
        try {
            if (args.Length != 3) return 64;
            string root = Path.GetFullPath(args[2]).TrimEnd('\\');
            string ownRoot = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
            if (!String.Equals(root, ownRoot, StringComparison.OrdinalIgnoreCase)) return 65;
            if (!Path.IsPathRooted(args[0]) || !File.Exists(args[0]) ||
                !String.Equals(Path.GetFileName(args[0]), "pwsh.exe", StringComparison.OrdinalIgnoreCase)) return 66;
            if (args[1] != "Run-Bridge.ps1" && args[1] != "Start-Bridge.ps1" && args[1] != "Stop-Bridge.ps1") return 67;
            string script = Path.Combine(root, args[1]);
            if (!File.Exists(script)) return 68;
            var start = new ProcessStartInfo(args[0], "-NoLogo -NoProfile -NonInteractive -File " + Quote(script) + " -InstallRoot " + Quote(root));
            start.WorkingDirectory = root;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.WindowStyle = ProcessWindowStyle.Hidden;
            start.RedirectStandardInput = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            IntPtr job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) return 71;
            try {
            var limits = new JobLimits(); limits.Basic.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(JobLimits)))) return 72;
            using (var child = Process.Start(start)) {
                if (!AssignProcessToJobObject(job, child.Handle)) { child.Kill(); child.WaitForExit(); return 73; }
                child.StandardInput.Close();
                // Stream to nowhere: no growing buffers, no pipe deadlock, no message logging.
                Task stdout = child.StandardOutput.BaseStream.CopyToAsync(Stream.Null);
                Task stderr = child.StandardError.BaseStream.CopyToAsync(Stream.Null);
                child.WaitForExit();
                // Descendants may inherit pipe handles. Close the job before
                // draining so an orphan cannot keep this task alive forever.
                CloseHandle(job); job = IntPtr.Zero;
                Task.WaitAll(stdout, stderr);
                return child.ExitCode;
            }
            } finally { if (job != IntPtr.Zero) CloseHandle(job); }
        } catch { return 70; } // Never show GUI error dialogs or console windows.
    }
}
