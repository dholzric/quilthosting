# Photography in the starter kits

The kits ship with photographs so that the photo-led designs — a split hero, a
full-bleed opener, a portfolio — are seen with a photograph in them. Before
this, every picture slot held generated quilt-block art, which meant those
designs had never actually been looked at as intended.

## Where the photographs come from

All of them are from [Unsplash](https://unsplash.com). Nothing is copied into
this repository or into R2: `src/lib/site/photos.ts` holds the photo ids, and
the URL is built against Unsplash's CDN, which resizes and re-encodes on
request. That is why the responsive widths the renderer asks for cost us
nothing to store.

## Licence

The [Unsplash Licence](https://unsplash.com/license) grants an irrevocable,
nonexclusive, worldwide copyright licence to download, copy, modify,
distribute, perform and use photos free of charge, including for commercial
purposes, without permission from or attributing the photographer.

Attribution is not required. It is offered here because the photographers gave
the work away and it costs us nothing to say so.

## What is not allowed

- Selling unaltered copies of a photo, or compiling them to replicate a
  competing service.
- Using photos of identifiable people in a way that suggests endorsement.

Neither applies to a quilt guild's website, which is what these are for.

## The photographs

A tenant may replace any of them with their own; a guild's own quilts will
always beat stock. These are the starting point, not the destination.

| Reference | Shows |
| --- | --- |
| `photo:1594526761005-4ccdbd608d2b` | A patchwork quilt in white, brown and black |
| `photo:1602730273286-22b077c994de` | A quilt close up, many colours meeting at the seams |
| `photo:1531456786827-de29dd0fa8b7` | A multicoloured patchwork throw |
| `photo:1634075853493-66688f345d87` | A quilt spread across a bed, seen close |
| `photo:1570362685387-3cf5499c3fdc` | A quilt in grey and green |
| `photo:1692561146174-d108741eee80` | A colourful quilt on a bed |
| `photo:1623111773154-05d3be4a70d7` | A quilt in white, red and green |
| `photo:1755138452921-650d508d6b54` | A colourful quilt over a wooden fence post |
| `photo:1701350659612-c4740dac512b` | A patchwork quilt of many colours and patterns |
| `photo:1610768400574-a588f7e1a7b7` | Green and beige floral quilting fabric |
| `photo:1610768399515-8df89e969e11` | Blue and white floral quilting fabric |
| `photo:1755138207288-b5c8fb5b8614` | A checked quilt over a wooden railing |
| `photo:1692561141101-c1528235e6bf` | A colourful quilt on a bed |
| `photo:1630930678172-63343537a00a` | Someone working at a sewing machine |
| `photo:1606501126768-b78d4569d3f9` | Someone sewing in a grey shirt |
| `photo:1641320197434-6ae0ca235048` | Hands guiding fabric through a sewing machine |
| `photo:1533758488827-1ed0f9b03899` | A quilter at a sewing machine |
| `photo:1663612619657-f876bfca791e` | A hand holding scissors and reading glasses |
| `photo:1466027397211-20d0f2449a3f` | An old black and yellow sewing machine |
| `photo:1626274890657-e28d5b65b04b` | A sewing machine on a wooden table |
| `photo:1564848534648-558dc1ef55c7` | A blue vintage sewing machine |
| `photo:1673786586360-19e8f8acb53f` | A sewing machine at work, close up |
| `photo:1497997092403-f091fcf5b6c4` | A presser foot and thread on dark cloth |
| `photo:1560796952-f1c9b838544c` | A sewing machine in black and white |
| `photo:1516707471165-777029111409` | Silk and scissors laid out on a table |
| `photo:1542044801-30d3e45ae49a` | Spools of thread in many colours |
| `photo:1578353022142-09264fd64295` | Threads and scissors on a work table |
| `photo:1536867520774-5b4f2628a69b` | A tape measure and scissors |
| `photo:1502217625004-89c03571bcca` | A sewing needle, very close |

## Checking they still resolve

`npm run photos:check` fetches every id and reports any that no longer return
an image. Run it before a release; a photo removed at source would otherwise
become a blank hero on every site that uses it.
