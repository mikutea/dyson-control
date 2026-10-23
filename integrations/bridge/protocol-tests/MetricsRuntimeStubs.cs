// Runtime inputs only: the fixture compiles and exercises the real publisher and file store.
internal static class GameMain
{
    internal static bool isPaused;
    internal static long gameTick;
}

internal static class FPSController
{
    internal static double currentUPS;
}

namespace NebulaWorld
{
    internal static class Multiplayer
    {
        internal static MultiplayerSession Session;
    }

    internal sealed class MultiplayerSession
    {
        internal bool CanPause;
    }
}
