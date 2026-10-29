# Four-way results

LCP in milliseconds, median (minimum to maximum), five audits per cell:

| Page    | Device  | Remix                  | Shipped                | Main                   | Fixed                  |
| ------- | ------- | ---------------------- | ---------------------- | ---------------------- | ---------------------- |
| home    | mobile  | 5,426 (3,169 to 5,434) | 3,465 (3,019 to 3,615) | 4,066 (3,918 to 4,213) | 3,614 (3,463 to 4,020) |
| home    | desktop | 1,050 (697 to 1,080)   | 740 (694 to 847)       | 930 (693 to 967)       | 836 (696 to 968)       |
| pricing | mobile  | 2,572 (2,415 to 3,018) | 2,564 (2,268 to 2,715) | 3,013 (2,864 to 3,015) | 2,868 (2,863 to 3,013) |
| pricing | desktop | 841 (577 to 847)       | 574 (539 to 616)       | 652 (453 to 653)       | 613 (612 to 652)       |
| docs    | mobile  | 2,727 (2,724 to 3,025) | 3,015 (2,719 to 3,018) | 3,015 (2,867 to 3,168) | 3,013 (2,862 to 3,014) |
| docs    | desktop | 1,779 (1,661 to 1,817) | 2,144 (2,010 to 2,179) | 2,112 (2,035 to 2,276) | 1,351 (1,337 to 1,372) |

[All Lighthouse scores and metrics](./LIGHTHOUSE.md),
[all audit samples](./lighthouse-runs.json).

Observed local homepage at 100 ms added request latency, five fresh 1350×940
contexts per source, without simulated mobile CPU throttling:

| Metric                                 | Remix                        | Shipped                      | Main                         | Fixed                        |
| -------------------------------------- | ---------------------------- | ---------------------------- | ---------------------------- | ---------------------------- |
| Initial JS encoded bytes               | 145,878 (145,878 to 145,878) | 259,010 (259,010 to 259,010) | 281,455 (281,455 to 281,455) | 240,021 (240,021 to 240,021) |
| Native plus external CSS raw bytes     | 0 (0 to 0)                   | 78,550 (78,550 to 78,550)    | 157,135 (157,135 to 157,135) | 122,828 (122,828 to 122,828) |
| All style text plus external CSS bytes | 62,958 (62,958 to 62,958)    | 100,791 (100,791 to 100,791) | 178,906 (178,906 to 178,906) | 144,599 (144,599 to 144,599) |
| Observed FCP ms                        | 256 (252 to 276)             | 276 (272 to 280)             | 280 (276 to 280)             | 264 (252 to 280)             |
| Observed LCP ms                        | 688 (684 to 708)             | 440 (432 to 444)             | 440 (432 to 448)             | 264 (252 to 280)             |
| Hydration marker ms                    | 668 (664 to 682)             | 1,824 (1,817 to 1,827)       | 1,934 (1,928 to 1,941)       | 1,395 (1,392 to 1,399)       |
| Document gzip body bytes               | 27,618 (27,610 to 27,626)    | 21,927 (21,916 to 21,933)    | 33,739 (33,718 to 33,751)    | 53,305 (53,297 to 53,314)    |
| Document decoded bytes                 | 152,666 (152,478 to 152,867) | 125,349 (125,106 to 125,562) | 142,679 (142,626 to 142,725) | 266,854 (266,801 to 266,935) |

Navigation at 100 ms added latency, median milliseconds (minimum to maximum):

| Scenario/step | Destination | Remix            | Shipped          | Main             | Fixed            |
| ------------- | ----------- | ---------------- | ---------------- | ---------------- | ---------------- |
| browser 1     | /pricing    | 147 (143 to 166) | 154 (142 to 159) | 128 (128 to 139) | 129 (128 to 134) |
| browser 2     | /docs       | 593 (576 to 593) | 477 (476 to 493) | 458 (456 to 469) | 460 (458 to 467) |
| browser 3     | /pricing    | 43 (42 to 44)    | 25 (19 to 26)    | 15 (15 to 16)    | 25 (25 to 26)    |
| private 1     | /@jane      | 135 (123 to 140) | 467 (465 to 474) | 446 (444 to 449) | 242 (240 to 254) |
| private 2     | /account    | 164 (147 to 165) | 130 (128 to 130) | 127 (125 to 131) | 130 (130 to 133) |

Both latency settings and every sample remain in
[navigation summaries](./navigation-summary.json),
[public samples](./browser-runs.json), [signed-in samples](./private-runs.json)
and [initial summaries](./initial-summary.json).

| Build/startup/inventory      | Remix     | Shipped   | Main      | Fixed     |
| ---------------------------- | --------- | --------- | --------- | --------- |
| First build ms               | 2,204     | 7,517     | 8,838     | 7,606     |
| Warm build median ms         | 2,072     | 7,444     | 8,130     | 7,495     |
| Startup active CPU median ms | 41.3      | 21.4      | 23.7      | 23.7      |
| Client JS/CSS files          | 57        | 621       | 646       | 426       |
| Client raw bytes             | 1,761,137 | 3,124,610 | 3,545,684 | 3,473,318 |
| Client per-file gzip bytes   | 528,876   | 1,064,064 | 1,191,179 | 1,152,949 |

Warm builds are the last five rotating rounds, the first build is separate. Full
emitted inventories include lazy routes and are not page transfer. See
[24 builds](./build-runs.json), [inventory totals](./inventory-summary.json),
[startup samples](./startup-runs.json), and
[source attribution](./attribution-summary.json).
