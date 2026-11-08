# Security

Report a vulnerability privately through [GitHub's private vulnerability reporting](https://github.com/idoo/billigast-mcp/security/advisories/new). Please don't open a public issue for it.

What counts: anything that lets someone use a hosted endpoint without its path token, run code on the host, read the host's secrets, or make the server send requests anywhere other than prisjakt.nu, pricerunner.se and the image hosts owp.klarna.com, pricespy-75b8.kxcdn.com and media.pji.nu.

The server only reads public Prisjakt and PriceRunner product and price data. It has no accounts, stores nothing and needs no API keys.
