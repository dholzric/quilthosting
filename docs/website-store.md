# Website, logo & store

Product HTML: [/docs/website-store.html](../public/docs/website-store.html)

## Logo

- Admin → Settings → Public profile → Guild logo
- PNG/JPEG/WebP/GIF/SVG, max 2 MB
- Public: `GET /public/:slug/logo`
- Also shown on join embeds

## Website

- Theme (color, font, style) + custom nav JSON
- Block types: heading, text, image, button, divider, html, join_cta, events_list, store_list, spacer
- Blog via `page_type=blog_post`

## Embeds

```
/embed/:slug/join
/embed/:slug/events
/embed/:slug/store
```

## Store

- Products: price cents, inventory, SKU, taxable
- Tax rate: basis points on tenant settings (`store.tax_rate_bps`)
- Public multi-SKU cart: `POST /public/:slug/cart/checkout`
