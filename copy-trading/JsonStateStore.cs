using System.Text.Json;

namespace CopyTrading;

public sealed class JsonStateStore : IStateStore
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private readonly string path;

    public JsonStateStore(string directory)
    {
        Directory.CreateDirectory(directory);
        path = Path.Combine(directory, "state.json");
    }

    public PersistedState Load()
    {
        if (!File.Exists(path)) return new();
        // Corrupt/unreadable data must prevent startup, never silently create an empty history.
        var state = JsonSerializer.Deserialize<PersistedState>(File.ReadAllBytes(path), Json)
            ?? throw new IOException("复制交易状态文件为空，未启动服务。请保留文件并检查。");
        if (state.Version != 1 || state.Rules == null || state.Logs == null)
            throw new IOException("不支持的复制交易状态文件，未启动服务。");
        return state;
    }

    public void Save(PersistedState state)
    {
        var temporary = path + ".tmp";
        using (var file = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            JsonSerializer.Serialize(file, state, Json);
            file.Flush(flushToDisk: true);
        }
        if (File.Exists(path)) File.Replace(temporary, path, path + ".bak");
        else File.Move(temporary, path);
    }
}
