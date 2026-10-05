# Ecommerce product images for the demo orders

Drop the generated files in the `incoming/` folder next to this file:

    backend/src/db/demo-images/incoming/

Name each file exactly `<slug>.png` (or .jpg / .webp), using the slugs below. Then tell Claude "images are in" and it will resize them and load them into the sandbox.

## Technical spec (apply to every image)

| Spec | Value |
|---|---|
| Aspect ratio | 1:1 (square) |
| Resolution | as large as Grok gives (1024 px or more is fine, no upscaling needed) |
| Format | PNG or JPG, one garment per image |
| Background | pure white (#FFFFFF), seamless, no floor line, no gradient |
| View | straight-on front view, garment centred, filling about 80% of the frame |
| Presentation | invisible / ghost mannequin for tops and jackets (garment looks worn but no body, head or hands); bottoms shown front on, same invisible mannequin |
| Lighting | soft even studio light, very faint contact shadow under the garment |
| Realism | photorealistic, visible fabric texture, real seams, zips and stitching |
| Must NOT contain | people, faces, hands, text, logos, brand names, watermarks, hangers, props, shoes, mockup frames |
| Consistency | identical framing, lighting and scale across all 16 images so the grid looks like one catalogue |

## How to use Grok

1. Open a new Grok chat and paste the **Master prompt** once. Tell it to wait for product lines.
2. Then paste one **Product line** at a time. Download each result and rename it to the slug.
3. If a result has a person, text or a coloured background, reply: "Regenerate. No person, no text, pure white seamless background, ghost mannequin, centred, square."
4. If the garment is cropped at the edge, reply: "Zoom out so the full garment fits with white margin on all sides."

### Master prompt (paste first)

> You are generating ecommerce catalogue photos for an apparel brand. For every product I send, create ONE image that follows these rules exactly: square 1:1; photorealistic studio product photograph; the single garment on an invisible ghost mannequin, straight-on front view, perfectly centred and filling about 80% of the frame with even white margin; pure white seamless background (#FFFFFF); soft, even, shadowless studio lighting with only a very faint contact shadow; sharp focus with visible fabric texture, stitching, zips and seams; neutral realistic colours. The image must contain NO people, faces, hands, models, text, logos, brand names, watermarks, hangers, props or shoes. Keep framing, lighting and scale identical for every product so the set looks like one catalogue. Reply "ready" and wait for the first product.

### Product lines (paste one at a time)

| File name | Product line to paste |
|---|---|
| `zip-up-recovery-jacket.png` | Product: Zip Up Recovery Jacket. Teal full-zip track jacket, stand-up collar, two zipped side pockets, ribbed cuffs and hem, lightweight brushed knit. |
| `cuffed-joggers.png` | Product: Cuffed Joggers. Charcoal grey fleece joggers, elastic waistband with flat drawcord, two side pockets, ribbed cuffed ankles. Front view, full length. |
| `recovery-tee.png` | Product: Recovery Tee. Plain white short-sleeve crew-neck performance t-shirt, soft jersey, clean hem, relaxed athletic fit. |
| `hooded-tank.png` | Product: Hooded Tank. White sleeveless hooded tank top, raw-edge armholes, flat drawcords, lightweight jersey. |
| `baggy-active-jacket.png` | Product: Baggy Active Jacket. Olive green oversized hooded full-zip jacket, dropped shoulders, ribbed cuffs and hem, matte nylon-poly stretch woven, two welt pockets. |
| `drifit-joggers.png` | Product: Drifit Joggers. Black tapered performance joggers, lightweight moisture-wicking fabric, zipped ankle, drawcord waist, subtle side seam panels. Front view, full length. |
| `studio-leggings.png` | Product: Studio Leggings. Black high-waist full-length leggings, wide flat waistband, plum-coloured mesh panels on the lower calves, matte brushed finish. |
| `pace-running-shorts.png` | Product: Pace Running Shorts. Orange-red lightweight running shorts, 5-inch inseam, split side hem, elastic waist with drawcord, micro-mesh fabric. |
| `core-crew-sweatshirt.png` | Product: Core Crew Sweatshirt. Navy crew-neck sweatshirt, ribbed collar, cuffs and hem, soft cotton-poly fleece, regular fit. |
| `stride-track-jacket.png` | Product: Stride Track Jacket. Royal blue full-zip track jacket with two red stripes down each sleeve, stand-up collar, ribbed cuffs and hem, smooth tricot fabric. |
| `flex-sports-bra.png` | Product: Flex Sports Bra. Black medium-support racerback sports bra, wide underband, scooped neckline, smooth nylon-spandex fabric. |
| `aero-windbreaker.png` | Product: Aero Windbreaker. Black lightweight hooded windbreaker with a subtle tone-on-tone grey floral print, full zip, elastic cuffs, packable ripstop nylon. |
| `long-sleeve-training-tee.png` | Product: Long Sleeve Training Tee. Black fitted long-sleeve crew-neck training top, flatlock seams, thumbholes in the cuffs, stretch interlock fabric. |
| `cropped-fleece-hoodie.png` | Product: Cropped Fleece Hoodie. Orange cropped pullover hoodie with kangaroo pocket and flat drawcords, ribbed cuffs and hem, soft cotton-poly fleece. |
| `slim-fit-jeans.png` | Product: Slim Fit Jeans. Mid-blue stonewash slim-fit jeans, five-pocket styling, button fly, subtle whiskering, full length, front view. |
| `polo-tshirt.png` | Product: Polo T-Shirt. Light grey short-sleeve piqué polo shirt, two-button placket, ribbed collar and sleeve cuffs, clean hem. |

Colours above match the colourways on the demo orders. Change a colour here and in the order if you want a different shade.
