---
name: amazon-ads
description: Browse Amazon Ads profiles/campaigns and request bounded SP/SB reports through OM.
---
Use installed OM tools only; credentials, vendor HTTP and configuration stay server-owned.
List profiles, select a connected profile, then list SP or SB campaigns one page at a time.
Request spCampaigns for traffic/cost or sbPurchasedProduct for purchased-product metrics.
Report creation uses the existing normal write grant; get/download use read policy.
Pass inclusive ISO dates, at most 31 days. Check status separately; never create a polling worker.
Download by report ID only. Never ask for, return or accept a signed report URL.
On expired/unauthenticated, direct the owner to reconnect through sealed paste-token ingress.
Unknown report requests must reconcile read-only; do not automatically resend them.
Deployment, activation, conversions and OAuth sign-in are unavailable in R1.
