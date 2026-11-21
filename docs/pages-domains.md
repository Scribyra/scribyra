# Custom domains

The presentation uses `https://scribyra.com/`; the application uses
`https://app.scribyra.com/`. Both serve the same release from two GitHub Pages
sites (`app.scribyra.com`: the `Scribyra/scribyra` repository; `scribyra.com`:
`Scribyra/scribyra-site`), and the generated host router opens the appropriate
shell. The application's address from before the custom domains,
`https://scribyra-aca39a.gitlab.io/app/` (the project's former GitLab Pages
deployment), now redirects to a GitLab sign-in. Pages settings, the Cloudflare DNS
records and certificates are in [delivery](delivery.md), "Hosting".

## Mail addresses

The presentation contact link uses `contact@scribyra.com`. The operator mailbox is
`admin@scribyra.com`; the confirmed automated sender is `noreply@scribyra.com`.
These addresses do not configure SMTP or enable notifications. Automated sending
requires separate runtime mail credentials/configuration. Preserve the existing
mail provider's MX, SPF, DKIM and verification records when editing Pages DNS.

## Company details

Scribyra is operated by URUNDEAD LABS S.R.L. The public details are the legal name,
registered office, Reg. Com. J2026034271001 (EUID ROONRC.J2026034271001),
CUI 54762154, VAT RO55538423 and `contact@scribyra.com`. They
appear in the footer of `site/index.html`, `site/privacy.html`,
`site/licenses.html` and `site/telemetry.html`, on the privacy page and in
`COPYRIGHT`. Publish nothing else, such as a phone number or bank details.

## Release and verification

`npm run build:pages` builds the legacy application and a small root shell, then
assembles `.pages`. The compiler files are stored once under `/app/core/busytex`;
the root shell reuses them. Local staging uses hard links without modifying build
inputs. CI publishes this artifact and registers its browser-app release link.

`ops/pages/domains.json` set `active: true` on November 6, 2026, after both domains
verified, certificates served consistently, and a browser verified presentation →
app, compilation and offline reload at `https://app.scribyra.com/`. Pages needs no
sign-in. Release and environment links now use that address. The hostname routing is already present in the artifact
so it can be checked before promoting those links.

Projects are browser-local and scoped to their origin; changing domains does not
move browser storage. A project still stored under the old address has to be
exported there as a ZIP and imported at the new address, which is only possible
while the old address serves the app. It currently asks for a GitLab sign-in.

Browser coverage in `tests/browser/pages-domains.spec.js` uses two loopback
hostnames to exercise the real root app, compiler, and offline service worker.
`tests/browser/pages.spec.js` covers the legacy `/app/` release.

References: [GitHub Pages custom domains](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)
and [Cloudflare CNAME flattening](https://developers.cloudflare.com/dns/cname-flattening/set-up-cname-flattening/).
