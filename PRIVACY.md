# Hoverleser: Privacy Policy

Last updated: October 2026

## Overview

Hoverleser is a browser extension for Firefox and Chromium-based browsers that provides offline German-to-English hover translation. We are committed to your privacy. This policy explains exactly what data the extension does and does not collect.

## Data We Collect

**None.** Hoverleser does not collect, transmit, store remotely, or share any personal data, browsing data, or usage data of any kind.

## Words You Hover Over

The words you hover over while using Hoverleser never leave your browser. All lookups are performed locally against a dictionary stored in your browser's IndexedDB. No hover events, search queries, or lookup results are sent anywhere.

The one exception is a word you choose to look up on LEO: clicking **Look up on LEO** in the popup opens LEO's website (`dict.leo.org`) in a new tab with that word as the search. That page is then subject to LEO's own privacy policy. The button can be hidden in the settings, and nothing is sent unless you click it.

## Dictionary Data

The dictionary is stored locally in your browser using IndexedDB. It is derived from Wiktionary via [kaikki.org](https://kaikki.org) (CC BY-SA 4.0) and is downloaded once at your explicit request. After download, no further network requests are made for dictionary lookups.

## Settings

Your extension settings (enabled/disabled state and display preferences) are stored locally using `browser.storage.local`. They are never transmitted to any server.

## Network Requests

The only network request Hoverleser makes is a one-time download of the dictionary from the project's GitHub Releases when you explicitly click **Download & Import German**. No other network requests are made at any time, including during normal hover usage. Clicking **Look up on LEO** opens a page in a new tab, as described above; Hoverleser itself makes no request to LEO.

## Third Parties

Hoverleser does not use any third-party analytics, advertising, or tracking services.

## Contact

If you have questions about this privacy policy, please open an issue at [github.com/o-i-z-y-s/hoverleser/issues](https://github.com/o-i-z-y-s/hoverleser/issues)
