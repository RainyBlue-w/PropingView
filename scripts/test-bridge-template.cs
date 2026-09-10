// The runner injects the actual production protection methods. Fake NT8 account objects
// acknowledge Change/Cancel locally: no network, no live or simulation account orders.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
enum OrderAction { Buy, Sell }
enum OrderType { Limit, StopMarket, Market }
enum OrderEntry { Manual }
enum TimeInForce { Day, Gtc }
enum MarketPosition { Flat, Long, Short }
enum OrderState { Initialized, Working, Accepted, PartFilled, Filled, Cancelled, Rejected, CancelPending, CancelSubmitted, ChangePending }
enum PrintTo { OutputTab1 }
namespace NinjaTrader.Code { static class Output { public static void Process(string s, object tab) {} } }
static class Core { public static class Globals { public static DateTime MaxDate = DateTime.MaxValue; } }
class MasterInstrument { public double PointValue = 10; public double RoundToTickSize(double p) { return Math.Round(p * 4) / 4; } }
class Instrument { public string FullName = "TEST"; public MasterInstrument MasterInstrument = new MasterInstrument(); }
class Position { public Instrument Instrument; public int Quantity; public MarketPosition MarketPosition; }
class Order {
    public Instrument Instrument; public string Oco, Name, OrderId = Guid.NewGuid().ToString();
    public OrderAction OrderAction; public OrderState OrderState = OrderState.Working; public TimeInForce TimeInForce;
    public int Filled, Quantity, QuantityChanged; public double LimitPrice, StopPrice, LimitPriceChanged, StopPriceChanged, AverageFillPrice = 100;
}
class Account {
    public string Name = "TEST-ACCOUNT"; public List<Order> Orders = new List<Order>(); public List<Position> Positions = new List<Position>();
    public int Submissions, Changes;
    public Order CreateOrder(Instrument i, OrderAction a, OrderType t, OrderEntry e, TimeInForce f, int q, double l, double s, string oco, string name, DateTime d, object x) {
        return new Order { Instrument = i, OrderAction = a, Quantity = q, LimitPrice = l, StopPrice = s, Name = name, Oco = oco, TimeInForce = f };
    }
    public void Submit(Order[] orders) { Submissions++; Orders.AddRange(orders); }
    public void Change(Order[] orders) { Changes++; foreach (var o in orders) { if (o.QuantityChanged < o.Filled) throw new Exception("total below filled"); o.Quantity = o.QuantityChanged; o.LimitPrice = o.LimitPriceChanged; o.StopPrice = o.StopPriceChanged; } }
    public void Cancel(Order[] orders) { foreach (var o in orders) o.OrderState = OrderState.Cancelled; }
}
class Probe {
    class PendingBracket { public Account Acc; public string Instrument; public double Tp, Sl, TpAmount, SlAmount; public Order Entry; public bool Activated, PositionObserved; }
    class CachedPosition { public int Quantity = 0; }
    readonly object bracketLock = new object();
    readonly Dictionary<Order, PendingBracket> pendingBrackets = new Dictionary<Order, PendingBracket>();
    readonly HashSet<Account> protectionWorkers = new HashSet<Account>();
    readonly Dictionary<Account,long> protectionRevisions = new Dictionary<Account,long>();
    readonly ConcurrentDictionary<string,string> protectionErrors = new ConcurrentDictionary<string,string>();
    readonly Dictionary<string,CachedPosition> positionCache = new Dictionary<string,CachedPosition>();
    bool running = false;
    static bool IsWorkingState(OrderState s) { return s != OrderState.Filled && s != OrderState.Cancelled && s != OrderState.Rejected; }
    /* PRODUCTION_METHODS */
    static void Check(bool ok, string name) { if (!ok) throw new Exception(name); Console.WriteLine("PASS " + name); }
    static Account Make(int signed) {
        var acc = new Account(); acc.Positions.Add(new Position { Instrument = new Instrument(), Quantity = Math.Abs(signed), MarketPosition = signed > 0 ? MarketPosition.Long : signed < 0 ? MarketPosition.Short : MarketPosition.Flat }); return acc;
    }
    static Order Leg(Account a, string name, string oco, int qty, OrderAction action = OrderAction.Sell, int filled = 0) {
        var o = new Order { Instrument = a.Positions[0].Instrument, Name = name, Oco = oco, Quantity = qty, Filled = filled, OrderAction = action, LimitPrice = name.Contains("TP") ? 110 : 0, StopPrice = name.Contains("SL") ? 90 : 0 };
        a.Orders.Add(o); return o;
    }
    static void Main() {
        var bridge = new Probe();
        var a = Make(5); var tp = Leg(a, "TV TP", "pair", 2); var sl = Leg(a, "TV SL", "pair", 2);
        var external = Leg(a, "ATM Stop1", "external", 1);
        bridge.ReconcileProtection(a);
        Check(tp.Quantity == 5 && sl.Quantity == 5 && tp.LimitPrice == 110 && sl.StopPrice == 90 && external.Quantity == 1, "add position resizes original legs, preserves prices and external orders");
        a.Positions[0].Quantity = 2; tp.Filled = 1; tp.OrderState = OrderState.PartFilled;
        bridge.ReconcileProtection(a);
        Check(tp.Quantity == 3 && sl.Quantity == 2, "partial exit includes filled quantity in total, remaining matches position");
        a.Positions[0].MarketPosition = MarketPosition.Flat; a.Positions[0].Quantity = 0; bridge.ReconcileProtection(a);
        Check(tp.OrderState == OrderState.Cancelled && sl.OrderState == OrderState.Cancelled && external.OrderState == OrderState.Working, "flat cancels terminal protection only");
        a = Make(-3); tp = Leg(a, "TV TP", "old", 2); sl = Leg(a, "TV SL", "old", 2); bridge.ReconcileProtection(a);
        Check(tp.OrderState == OrderState.Cancelled && sl.OrderState == OrderState.Cancelled, "reversal cancels protection for old direction");
        a = Make(5); var tp1 = Leg(a, "TV TP", "a", 2); var sl1 = Leg(a, "TV SL", "a", 2); var tp2 = Leg(a, "TV TP", "b", 1); var sl2 = Leg(a, "TV SL", "b", 1);
        bridge.ReconcileProtection(a);
        Check(tp1.Quantity == 3 && sl1.Quantity == 3 && tp2.Quantity == 2 && sl2.Quantity == 2, "multiple OCO pairs share total position proportionally");
        a.Positions[0].Quantity = 1; bridge.ReconcileProtection(a);
        Check(tp1.Quantity == 1 && sl1.Quantity == 1 && tp2.OrderState == OrderState.Cancelled && sl2.OrderState == OrderState.Cancelled, "integer reduction removes zero-allocation pair");
        a = Make(1); var entry = Leg(a, "TV Entry", "", 3, OrderAction.Buy, 1); entry.OrderState = OrderState.PartFilled;
        bridge.RegisterBracketOnFill(a, entry.Instrument, OrderAction.Buy, 3, 110, 90, 0, 0, entry, TimeInForce.Gtc);
        bridge.ReconcileProtection(a);
        Check(a.Submissions == 1 && a.Orders.Where(IsManagedProtection).All(o => o.Quantity == 1), "first partial entry immediately receives protection");
        entry.Filled = 3; entry.OrderState = OrderState.Filled; a.Positions[0].Quantity = 3;
        bridge.ReconcileProtection(a);
        Check(a.Submissions == 1 && a.Orders.Where(IsManagedProtection).All(o => o.Quantity == 3) && bridge.pendingBrackets.Count == 0, "later fills resize same pair, remove terminal registration");
        entry = Leg(a, "TV Entry", "", 2, OrderAction.Buy, 2); entry.OrderState = OrderState.Filled; a.Positions[0].Quantity = 5;
        bridge.RegisterBracketOnFill(a, entry.Instrument, OrderAction.Buy, 2, 120, 80, 0, 0, entry, TimeInForce.Gtc); bridge.ReconcileProtection(a);
        Check(a.Submissions == 1 && a.Orders.Where(IsManagedProtection).All(o => o.Quantity == 5), "bracketed addition does not create another full position pair");
        a = Make(0); entry = Leg(a, "TV Entry", "", 1, OrderAction.Buy); entry.OrderState = OrderState.Cancelled;
        bridge.RegisterBracketOnFill(a, entry.Instrument, OrderAction.Buy, 1, 110, 90, 0, 0, entry, TimeInForce.Gtc); bridge.ReconcileProtection(a);
        Check(bridge.pendingBrackets.Count == 0 && a.Submissions == 0, "cancelled unfilled entry leaves no registration or event handler");
        entry = Leg(a, "TV Entry", "", 1, OrderAction.Buy, 1); entry.OrderState = OrderState.Filled;
        bridge.RegisterBracketOnFill(a, entry.Instrument, OrderAction.Buy, 1, 110, 90, 0, 0, entry, TimeInForce.Gtc);
        bridge.pendingBrackets[entry].PositionObserved = true; bridge.ReconcileProtection(a);
        Check(bridge.pendingBrackets.Count == 0 && a.Submissions == 0, "entry closed before worker runs cannot attach stale protection to a later position");
    }
}
