namespace SpeedOFreq.Core;

/// <summary>
/// In-memory credentials supplied by a browser extension for a user-approved transfer.
/// This object is intentionally not part of persisted queue metadata.
/// </summary>
public sealed class BrowserRequestContext
{
    public IReadOnlyList<BrowserCookie> Cookies { get; init; } = [];
    public string? Referer { get; init; }
    public string? UserAgent { get; init; }
    public string? Name { get; init; }

    public IReadOnlyDictionary<string, string> HeadersFor(Uri target)
    {
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["User-Agent"] = string.IsNullOrWhiteSpace(UserAgent) ? "Speed-o-Freq Sonic/2.0" : UserAgent
        };
        if (Uri.TryCreate(Referer, UriKind.Absolute, out var referer)
            && referer.Scheme is "http" or "https")
        {
            // Follow the browser default cross-origin referrer policy: send a full referrer
            // only to the same origin; otherwise only the origin. Never downgrade HTTPS.
            var sameOrigin = string.Equals(referer.Scheme, target.Scheme, StringComparison.OrdinalIgnoreCase)
                && string.Equals(referer.Host, target.Host, StringComparison.OrdinalIgnoreCase)
                && referer.Port == target.Port;
            headers["Referer"] = sameOrigin ? referer.AbsoluteUri : referer.GetLeftPart(UriPartial.Authority) + "/";
        }

        var host = target.Host;
        var path = string.IsNullOrEmpty(target.AbsolutePath) ? "/" : target.AbsolutePath;
        var cookies = Cookies
            .Where(cookie =>
            {
                var domain = cookie.Domain.TrimStart('.').ToLowerInvariant();
                var requestHost = host.ToLowerInvariant();
                var domainMatches = cookie.HostOnly
                    ? requestHost == domain
                    : requestHost == domain || requestHost.EndsWith("." + domain, StringComparison.Ordinal);
                var cookiePath = string.IsNullOrEmpty(cookie.Path) ? "/" : cookie.Path;
                var pathMatches = path == cookiePath
                    || (path.StartsWith(cookiePath, StringComparison.Ordinal)
                        && (cookiePath.EndsWith("/", StringComparison.Ordinal) || path.Length > cookiePath.Length && path[cookiePath.Length] == '/'));
                return domainMatches && pathMatches && (!cookie.Secure || target.Scheme == Uri.UriSchemeHttps);
            })
            .OrderByDescending(cookie => cookie.Path.Length)
            .Select(cookie => string.IsNullOrEmpty(cookie.Name) ? cookie.Value : $"{cookie.Name}={cookie.Value}")
            .ToArray();
        if (cookies.Length > 0) headers["Cookie"] = string.Join("; ", cookies);
        return headers;
    }
}

public sealed record BrowserCookie(string Name, string Value, string Domain, bool HostOnly, string Path, bool Secure);