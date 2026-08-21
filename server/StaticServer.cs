// NT8Terminal —— NT8 行情终端的独立静态文件服务器
// 用 .NET Framework 自带 csc.exe 编译,无需安装任何运行时:
//   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /target:exe /out:NT8Terminal.exe StaticServer.cs
// 双击 NT8Terminal.exe 启动;关闭控制台窗口或在任务管理器结束 NT8Terminal.exe 即停止。
using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Nt8Terminal
{
    internal static class StaticServer
    {
        private static readonly Dictionary<string, string> Mime = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            { ".html", "text/html; charset=utf-8" },
            { ".js",   "application/javascript; charset=utf-8" },
            { ".css",  "text/css; charset=utf-8" },
            { ".json", "application/json; charset=utf-8" },
            { ".map",  "application/json; charset=utf-8" },
            { ".png",  "image/png" },
            { ".jpg",  "image/jpeg" },
            { ".svg",  "image/svg+xml" },
            { ".ico",  "image/x-icon" },
            { ".woff", "font/woff" },
            { ".woff2","font/woff2" },
            { ".txt",  "text/plain; charset=utf-8" },
        };

        private static int Main(string[] args)
        {
            // 端口:默认 7200(与 Kimi Work 预览的 dev 服务器 7100 错开),
            // 可用命令行参数覆盖,如 NT8Terminal.exe 7100
            int port = 7200;
            if (args.Length > 0) int.TryParse(args[0], out port);

            // 站点根目录:优先 exe 旁的 app\dist,其次 exe 旁的 dist
            string exeDir = AppDomain.CurrentDomain.BaseDirectory;
            string root = Path.Combine(exeDir, "app", "dist");
            if (!Directory.Exists(root)) root = Path.Combine(exeDir, "dist");
            if (!Directory.Exists(root))
            {
                Console.WriteLine("[×] 找不到前端构建目录:" + root);
                Console.WriteLine("    请先在 app 目录执行 npm run build,再启动本程序。");
                WaitKey();
                return 1;
            }

            var listener = new TcpListener(IPAddress.Loopback, port);
            try { listener.Start(); }
            catch (SocketException)
            {
                Console.WriteLine("[×] 端口 " + port + " 被占用(先关掉占用它的进程,或换个端口参数)。");
                WaitKey();
                return 1;
            }

            Console.Title = "NT8 行情终端 - http://127.0.0.1:" + port + "/";
            Console.WriteLine("NT8 行情终端已启动:  http://127.0.0.1:" + port + "/");
            Console.WriteLine("站点目录: " + root);
            Console.WriteLine("关闭本窗口(或在任务管理器结束 NT8Terminal.exe)即停止服务。");
            try { System.Diagnostics.Process.Start("http://127.0.0.1:" + port + "/"); } catch { }

            while (true)
            {
                TcpClient client = listener.AcceptTcpClient();
                Task.Run(() => Handle(client, root));
            }
        }

        // 后台/重定向环境下 Console.ReadKey 会抛异常,吞掉即可
        private static void WaitKey()
        {
            try { Console.ReadKey(true); } catch { }
        }

        private static void Handle(TcpClient client, string root)
        {
            using (client)
            {
                client.ReceiveTimeout = 10000;
                client.SendTimeout = 30000;
                NetworkStream ns = client.GetStream();
                string requestLine;
                try { requestLine = ReadRequestLine(ns); } catch { return; }
                if (string.IsNullOrEmpty(requestLine)) return;                string[] parts = requestLine.Split(' ');
                if (parts.Length < 2 || parts[0].ToUpperInvariant() != "GET") { WriteSimple(ns, 405, "Method Not Allowed"); return; }

                string path = Uri.UnescapeDataString(parts[1].Split('?')[0]);
                if (path.Contains("..")) { WriteSimple(ns, 403, "Forbidden"); return; }
                string rel = path.TrimStart('/').Replace('/', Path.DirectorySeparatorChar);
                string file = Path.Combine(root, rel);

                // SPA 回退:无扩展名的路径一律回 index.html
                if ((!File.Exists(file) && !Path.HasExtension(rel)) || (Directory.Exists(file)))
                    file = Path.Combine(root, "index.html");
                if (!File.Exists(file)) { WriteSimple(ns, 404, "Not Found"); return; }

                byte[] data;
                try { data = File.ReadAllBytes(file); } catch { WriteSimple(ns, 500, "Read Error"); return; }
                string ext = Path.GetExtension(file);
                string m;
                string mime = Mime.TryGetValue(ext, out m) ? m : "application/octet-stream";

                var head = Encoding.ASCII.GetBytes(
                    "HTTP/1.1 200 OK\r\n" +
                    "Content-Type: " + mime + "\r\n" +
                    "Content-Length: " + data.Length + "\r\n" +
                    "Cache-Control: no-cache\r\n" +
                    "Connection: close\r\n\r\n");
                try { ns.Write(head, 0, head.Length); ns.Write(data, 0, data.Length); } catch { }
            }
        }

        // 读取完整请求头(直到空行)并返回请求行。
        // 必须把客户端发来的头部全部读完:若接收缓冲区残留未读数据,
        // 直接关连接会触发 TCP RST,把尚未送达的大文件响应拦腰截断。
        private static string ReadRequestLine(NetworkStream ns)
        {
            var ms = new MemoryStream();
            var buf = new byte[4096];
            int total = 0;
            while (total < 65536)
            {
                int n = ns.Read(buf, 0, buf.Length);
                if (n <= 0) break;
                ms.Write(buf, 0, n);
                total += n;
                byte[] cur = ms.ToArray();
                if (IndexOfHeaderEnd(cur) >= 0)
                {
                    string text = Encoding.ASCII.GetString(cur);
                    int eol = text.IndexOf('\n');
                    return eol > 0 ? text.Substring(0, eol).TrimEnd('\r') : text.TrimEnd('\r');
                }
            }
            byte[] all = ms.ToArray();
            if (all.Length == 0) return string.Empty;
            string fallback = Encoding.ASCII.GetString(all);
            int nl = fallback.IndexOf('\n');
            return nl > 0 ? fallback.Substring(0, nl).TrimEnd('\r') : fallback.TrimEnd('\r');
        }

        private static int IndexOfHeaderEnd(byte[] buf)
        {
            for (int i = 0; i + 3 < buf.Length; i++)
            {
                if (buf[i] == 13 && buf[i + 1] == 10 && buf[i + 2] == 13 && buf[i + 3] == 10)
                    return i;
            }
            return -1;
        }

        private static void WriteSimple(NetworkStream ns, int code, string text)
        {
            byte[] body = Encoding.UTF8.GetBytes(text);
            var head = Encoding.ASCII.GetBytes(
                "HTTP/1.1 " + code + " " + text + "\r\n" +
                "Content-Type: text/plain; charset=utf-8\r\n" +
                "Content-Length: " + body.Length + "\r\n" +
                "Connection: close\r\n\r\n");
            try { ns.Write(head, 0, head.Length); ns.Write(body, 0, body.Length); } catch { }
        }
    }
}
