// NT8Terminal —— NT8 行情终端的静态文件服务器与同源 NT8 API 代理
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
        // 桥接始终留在本机；浏览器仅连接前端服务器，无需开放 8090 端口。
        private const string BridgeOrigin = "http://127.0.0.1:8090";
        private const string AtasBridgeOrigin = "http://127.0.0.1:8091";
        private const int BridgeTimeoutMs = 30000;
        private const int MaxBodyBytes = 16 * 1024 * 1024;

        private sealed class Request
        {
            public string Method;
            public string Target;
            public Dictionary<string, string> Headers;
            public byte[] Body;
        }

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
            // 可用命令行参数覆盖,如 NT8Terminal.exe 7200 --host 0.0.0.0
            int port = 7200;
            IPAddress address = IPAddress.Loopback;
            bool openBrowser = true;
            bool hasPort = false;
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--no-browser") openBrowser = false;
                else if (args[i] == "--host" && i + 1 < args.Length && IPAddress.TryParse(args[++i], out address)) { }
                else if (!hasPort && int.TryParse(args[i], out port) && port > 0 && port <= 65535) hasPort = true;
                else
                {
                    Console.WriteLine("用法: NT8Terminal.exe [端口] [--host IP地址] [--no-browser]");
                    return 1;
                }
            }

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

            var listener = new TcpListener(address, port);
            try { listener.Start(); }
            catch (SocketException)
            {
                Console.WriteLine("[×] 端口 " + port + " 被占用(先关掉占用它的进程,或换个端口参数)。");
                WaitKey();
                return 1;
            }

            IPAddress browserAddress = address.Equals(IPAddress.Any) ? IPAddress.Loopback : address.Equals(IPAddress.IPv6Any) ? IPAddress.IPv6Loopback : address;
            string browserUrl = new UriBuilder("http", browserAddress.ToString(), port).Uri.AbsoluteUri;
            Console.Title = "NT8 行情终端 - " + browserUrl;
            Console.WriteLine("NT8 行情终端已启动:  " + browserUrl);
            Console.WriteLine("站点目录: " + root);
            Console.WriteLine("监听地址: " + address + ":" + port + "；/api/* 转发至 " + BridgeOrigin);
            Console.WriteLine("ATAS X: /atas/api/* 转发至 " + AtasBridgeOrigin + "/api/*");
            Console.WriteLine("关闭本窗口(或在任务管理器结束 NT8Terminal.exe)即停止服务。");
            if (openBrowser)
                try { System.Diagnostics.Process.Start(browserUrl); } catch { }

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
                Request request;
                try { request = ReadRequest(ns); }
                catch { WriteJsonError(ns, 400, "Bad Request", "Invalid or incomplete HTTP request"); return; }
                if (request == null) return;

                string rawPath = request.Target.Split('?')[0];
                bool atas = rawPath == "/atas/api" || rawPath.StartsWith("/atas/api/", StringComparison.Ordinal);
                if (atas || rawPath == "/api" || rawPath.StartsWith("/api/", StringComparison.Ordinal))
                {
                    if (request.Method != "GET" && request.Method != "POST")
                    {
                        WriteJsonError(ns, 405, "Method Not Allowed", "Only GET and POST are supported");
                        return;
                    }
                    ProxyApi(client, ns, request, atas);
                    return;
                }
                if (request.Method != "GET") { WriteSimple(ns, 405, "Method Not Allowed"); return; }

                string path = Uri.UnescapeDataString(rawPath);
                if (path.Contains("..")) { WriteSimple(ns, 403, "Forbidden"); return; }
                string rel = path.TrimStart('/').Replace('/', Path.DirectorySeparatorChar);
                string file;
                try
                {
                    string rootPrefix = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
                    file = Path.GetFullPath(Path.Combine(rootPrefix, rel));
                    if (!file.StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase) && !file.Equals(rootPrefix.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase))
                    {
                        WriteSimple(ns, 403, "Forbidden");
                        return;
                    }
                    // Windows drive/ADS and rooted paths are not site-relative resources.
                    if (Path.IsPathRooted(rel) || rel.Contains(":")) { WriteSimple(ns, 403, "Forbidden"); return; }
                }
                catch { WriteSimple(ns, 403, "Forbidden"); return; }

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

        // 读取完整请求头和 body，保留一次 Read 中已经读到的 body 字节。
        // 必须把客户端发来的头部全部读完:若接收缓冲区残留未读数据,
        // 直接关连接会触发 TCP RST,把尚未送达的大文件响应拦腰截断。
        private static Request ReadRequest(NetworkStream ns)
        {
            using (var ms = new MemoryStream())
            {
                var buf = new byte[4096];
                int headerEnd = -1;
                while (ms.Length < 65536)
                {
                    int n = ns.Read(buf, 0, buf.Length);
                    if (n <= 0)
                    {
                        if (ms.Length == 0) return null;
                        throw new IOException("Incomplete headers");
                    }
                    ms.Write(buf, 0, n);
                    headerEnd = IndexOfHeaderEnd(ms.ToArray());
                    if (headerEnd >= 0) break;
                }
                if (headerEnd < 0 || headerEnd > 65532) throw new IOException("Headers too large");
                byte[] received = ms.ToArray();
                string[] lines = Encoding.ASCII.GetString(received, 0, headerEnd).Split(new[] { "\r\n" }, StringSplitOptions.None);
                string[] parts = lines[0].Split(' ');
                if (parts.Length != 3 || !parts[1].StartsWith("/", StringComparison.Ordinal) || parts[1].StartsWith("//", StringComparison.Ordinal) || parts[1].Contains("\\"))
                    throw new IOException("Invalid request target");
                var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                for (int i = 1; i < lines.Length; i++)
                {
                    int colon = lines[i].IndexOf(':');
                    if (colon <= 0) throw new IOException("Invalid header");
                    string name = lines[i].Substring(0, colon).Trim();
                    if (headers.ContainsKey(name)) throw new IOException("Duplicate header");
                    headers.Add(name, lines[i].Substring(colon + 1).Trim());
                }
                // 浏览器 JSON 请求带 Content-Length；拒绝不支持的分块请求，避免歧义。
                if (headers.ContainsKey("Transfer-Encoding")) throw new IOException("Unsupported transfer encoding");
                int length = 0;
                string value;
                if (headers.TryGetValue("Content-Length", out value) && (!int.TryParse(value, out length) || length < 0 || length > MaxBodyBytes))
                    throw new IOException("Invalid body length");
                if (headers.TryGetValue("Expect", out value) && value.Equals("100-continue", StringComparison.OrdinalIgnoreCase))
                {
                    byte[] interim = Encoding.ASCII.GetBytes("HTTP/1.1 100 Continue\r\n\r\n");
                    ns.Write(interim, 0, interim.Length);
                }
                byte[] body = new byte[length];
                int copied = Math.Min(length, received.Length - headerEnd - 4);
                Buffer.BlockCopy(received, headerEnd + 4, body, 0, copied);
                while (copied < length)
                {
                    int n = ns.Read(body, copied, length - copied);
                    if (n <= 0) throw new IOException("Incomplete body");
                    copied += n;
                }
                return new Request { Method = parts[0].ToUpperInvariant(), Target = parts[1], Headers = headers, Body = body };
            }
        }

        private static void ProxyApi(TcpClient client, NetworkStream downstream, Request request, bool atas)
        {
            HttpWebRequest upstream = null;
            bool responseStarted = false;
            try
            {
                upstream = (HttpWebRequest)WebRequest.Create((atas ? AtasBridgeOrigin : BridgeOrigin) + (atas ? request.Target.Substring(5) : request.Target));
                upstream.Proxy = null;
                upstream.Method = request.Method;
                upstream.AllowAutoRedirect = false;
                upstream.KeepAlive = false;
                upstream.Timeout = BridgeTimeoutMs;
                upstream.ReadWriteTimeout = BridgeTimeoutMs;
                // .NET Framework 默认每个目标仅 2 个连接；长驻 SSE 不应堵住其它 API。
                upstream.ServicePoint.ConnectionLimit = 1024;
                upstream.ServicePoint.Expect100Continue = false;
                string value;
                if (request.Headers.TryGetValue("Content-Type", out value)) upstream.ContentType = value;
                if (request.Headers.TryGetValue("Accept", out value)) upstream.Accept = value;
                if (request.Headers.TryGetValue("Last-Event-ID", out value)) upstream.Headers["Last-Event-ID"] = value;
                if (request.Headers.TryGetValue("Authorization", out value)) upstream.Headers["Authorization"] = value;

                // 即使上游暂时没有事件，也要在页面关闭/刷新后中止长连接。
                HttpWebRequest tracked = upstream;
                using (var disconnect = new Timer(delegate(object state)
                {
                    try
                    {
                        if (client.Client.Poll(0, SelectMode.SelectRead) && client.Client.Available == 0) tracked.Abort();
                    }
                    catch { tracked.Abort(); }
                }, null, 250, 250))
                {
                    if (request.Body.Length > 0 || request.Method == "POST" || request.Method == "PUT" || request.Method == "PATCH")
                    {
                        upstream.ContentLength = request.Body.Length;
                        using (Stream output = upstream.GetRequestStream()) output.Write(request.Body, 0, request.Body.Length);
                    }
                    HttpWebResponse response;
                    try { response = (HttpWebResponse)upstream.GetResponse(); }
                    catch (WebException error)
                    {
                        response = error.Response as HttpWebResponse;
                        if (response == null) throw;
                    }
                    using (response)
                    using (Stream input = response.GetResponseStream())
                    {
                        bool isEvents = (response.ContentType ?? "").StartsWith("text/event-stream", StringComparison.OrdinalIgnoreCase);
                        if (isEvents && input.CanTimeout) input.ReadTimeout = Timeout.Infinite;
                        var head = new StringBuilder();
                        head.Append("HTTP/1.1 ").Append((int)response.StatusCode).Append(' ').Append(response.StatusDescription).Append("\r\n");
                        head.Append("Content-Type: ").Append(response.ContentType ?? "application/json; charset=utf-8").Append("\r\n");
                        if (response.ContentLength >= 0) head.Append("Content-Length: ").Append(response.ContentLength).Append("\r\n");
                        foreach (string name in new[] { "Cache-Control", "Content-Encoding", "Retry-After" })
                            if (!string.IsNullOrEmpty(response.Headers[name])) head.Append(name).Append(": ").Append(response.Headers[name]).Append("\r\n");
                        if (isEvents) head.Append("X-Accel-Buffering: no\r\n");
                        head.Append("Connection: close\r\n\r\n");
                        byte[] bytes = Encoding.ASCII.GetBytes(head.ToString());
                        responseStarted = true;
                        downstream.Write(bytes, 0, bytes.Length);
                        downstream.Flush();
                        var buffer = new byte[16384];
                        int count;
                        while ((count = input.Read(buffer, 0, buffer.Length)) > 0)
                        {
                            downstream.Write(buffer, 0, count);
                            downstream.Flush();
                        }
                    }
                }
            }
            catch (WebException error)
            {
                if (!responseStarted)
                {
                    bool timeout = error.Status == WebExceptionStatus.Timeout;
                    WriteJsonError(downstream, timeout ? 504 : 502, timeout ? "Gateway Timeout" : "Bad Gateway", (atas ? "ATAS X" : "NT8") + (timeout ? " bridge request timed out" : " bridge is unavailable"));
                }
            }
            catch
            {
                if (!responseStarted) WriteJsonError(downstream, 502, "Bad Gateway", (atas ? "ATAS X" : "NT8") + " bridge proxy failed");
            }
            finally { if (upstream != null) upstream.Abort(); }
        }

        private static void WriteJsonError(NetworkStream ns, int code, string reason, string message)
        {
            byte[] body = Encoding.UTF8.GetBytes("{\"ok\":false,\"error\":\"" + message + "\"}");
            byte[] head = Encoding.ASCII.GetBytes("HTTP/1.1 " + code + " " + reason + "\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: " + body.Length + "\r\nConnection: close\r\n\r\n");
            try { ns.Write(head, 0, head.Length); ns.Write(body, 0, body.Length); } catch { }
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
