# Security policy

## Reporting a vulnerability

A useful report includes:

- what an attacker can do, and what they need first (a crafted link or file, a malicious website, code already running on the computer)
- the steps or a small test that shows it, and the Sonic version and operating system
- a suggested fix, if you have one

## What to expect

Sonic is maintained by one person, so these are aims rather than promises:

- a reply within a week
- an assessment, and a planned fix or an explanation, within a few weeks
- a new release once it's fixed, which reaches users through automatic updates

The advisory is published once the fix has been released, with credit to you unless you'd rather stay anonymous. Please keep the details private until then.

## Supported versions

Only the latest release gets security fixes. Sonic updates itself, so most people are already on it.

## Scope

In scope:

- the Sonic app for macOS, Windows, and Linux, including its download, torrent, and update code
- the browser extension in `extension/`
- the release workflows and build setup in this repository

Out of scope:

- the getsonic.app landing page, unless the problem affects people downloading Sonic
- problems in a dependency that Sonic doesn't expose (please report those upstream)
- a malicious server sending the wrong content for a link you chose to download, unless Sonic makes it worse (for example, by writing outside the folder you picked)
