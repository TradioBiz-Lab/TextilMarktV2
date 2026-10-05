// The demo range: one customer (Aero Active), four master orders, fourteen styles.
// Used by demo.js (orders) and by build_techpacks.py (documents), so style numbers,
// colours and names never drift apart between the order and its tech pack.
//
// `mfr` is the factory key ('ncr' | 'blr'); `active` is the index of the TNA step in
// progress (12 means fully delivered); `delivery` is days from today.
export const MASTER_ORDERS = [
  { id: 'MO-AER-SS27-001', name: 'SS27 Outerwear' },
  { id: 'MO-AER-SS27-002', name: 'SS27 Bottoms' },
  { id: 'MO-AER-SS27-003', name: 'SS27 Tops and Tees' },
  { id: 'MO-AER-SS27-004', name: 'SS27 Fleece and Layers' },
]

export const STYLES = [
  // ── Outerwear ──
  { mo: 1, id: 'AER-NCR-JACKT-SS27-001', slug: 'baggy-active-jacket', product: 'Baggy Active Jacket', style: 'AER-BAJ-02', cat: 'JACKET', mfr: 'ncr', qty: 800, active: 12, delivery: -3, delivered: true,
    colours: ['Olive Green', 'Black'], fabric: 'Nylon-poly stretch woven 135 GSM', supplier: 'Surat Technical Fabrics', gender: 'Womens',
    source: 'Fitleasure - Core/Tech Packs/FLGCW17 Baggy Active Jacket.pdf' },
  { mo: 1, id: 'AER-NCR-JACKT-SS27-002', slug: 'zip-up-recovery-jacket', product: 'Zip Up Recovery Jacket', style: 'AER-ZRJ-01', cat: 'JACKET', mfr: 'ncr', qty: 1200, active: 6, delivery: 70,
    colours: ['Teal'], gender: 'Mens', source: 'Fitleasure - Core/Tech Packs/FLGCM17 Zip Up Recovery Jacket.pdf' },
  { mo: 1, id: 'AER-BSW-TRACK-SS27-001', slug: 'stride-track-jacket', product: 'Aero Track Jacket', style: 'AER-ATJ-03', cat: 'JACKET', mfr: 'blr', qty: 700, active: 2, delivery: 78, status: 'Delayed',
    callout: 'Tricot fabric lot rejected on shade, resubmitted. Material Sourcing pushed.', fabric: 'Poly tricot 190 GSM', colours: ['Royal Blue', 'Red'], gender: 'Mens',
    source: 'Fitleasure-HIIT/Mens/FLSM08 Lightweight Track Jacket.pdf' },
  { mo: 1, id: 'AER-NCR-WINDB-SS27-001', slug: 'aero-windbreaker', product: 'Aero Windbreaker', style: 'AER-AWB-04', cat: 'JACKET', mfr: 'ncr', qty: 900, active: 5, delivery: 52,
    fabric: 'Nylon ripstop 70D, PU coated', colours: ['Black Floral'], gender: 'Womens', source: 'Fitleasure-HIIT/Womens/FLSW08 Core Crop Jacket.pdf' },
  // ── Bottoms ──
  { mo: 2, id: 'AER-NCR-JOGGR-SS27-001', slug: 'cuffed-joggers', product: 'Cuffed Joggers', style: 'AER-CJ-05', cat: 'JOGGERS', mfr: 'ncr', qty: 1500, active: 7, delivery: 55,
    colours: ['Charcoal'], gender: 'Womens', source: 'Fitleasure - Core/Tech Packs/FLGCW16 Cuffed Joggers.pdf' },
  { mo: 2, id: 'AER-BSW-JOGGR-SS27-001', slug: 'drifit-joggers', product: 'Drifit Joggers', style: 'AER-DJ-06', cat: 'JOGGERS', mfr: 'blr', qty: 1100, active: 1, delivery: 80,
    colours: ['Black'], gender: 'Mens', source: 'Fitleasure-HIIT/Mens/FLSM06 Off Duty Joggers.pdf' },
  { mo: 2, id: 'AER-NCR-LEGGN-SS27-001', slug: 'studio-leggings', product: 'Studio Leggings', style: 'AER-SL-07', cat: 'LEGGINGS', mfr: 'ncr', qty: 2400, active: 8, delivery: 35,
    fabric: 'Nylon-spandex brushed jersey 260 GSM', colours: ['Black'], gender: 'Womens', source: 'Fitleasure-HIIT/Womens/FLSW01 Flow High Rise Leggings.pdf' },
  { mo: 2, id: 'AER-BSW-SHORT-SS27-001', slug: 'pace-running-shorts', product: 'Pace Running Shorts', style: 'AER-PRS-08', cat: 'SHORTS', mfr: 'blr', qty: 1800, active: 3, delivery: 62,
    fabric: 'Recycled poly micro-mesh 110 GSM', colours: ['Orange Red'], gender: 'Womens', source: 'Fitleasure-HIIT/Womens/FLSW05 High Rise Running Shorts.pdf' },
  // ── Tops and tees ──
  { mo: 3, id: 'AER-BSW-TSHRT-SS27-001', slug: 'recovery-tee', product: 'Recovery Tee', style: 'AER-RT-09', cat: 'TSHRT', mfr: 'blr', qty: 2000, active: 2, delivery: 60,
    callout: 'Fabric lot late from the mill, Material Sourcing past its planned date.', status: 'Delayed', colours: ['White'], gender: 'Mens',
    source: 'Fitleasure - Core/Tech Packs/FLGCM14 Recovery Tee.pdf' },
  { mo: 3, id: 'AER-BSW-LSTEE-SS27-001', slug: 'long-sleeve-training-tee', product: 'Long Sleeve Training Tee', style: 'AER-LST-10', cat: 'TSHRT', mfr: 'blr', qty: 1400, active: 1, delivery: 85,
    fabric: 'Poly-spandex interlock 180 GSM', colours: ['Black'], gender: 'Womens', source: 'Fitleasure-HIIT/Womens/FLSW03 Essential Tee.pdf' },
  { mo: 3, id: 'AER-BSW-HOODI-SS27-001', slug: 'hooded-tank', product: 'Hooded Tank', style: 'AER-HT-11', cat: 'TANK', mfr: 'blr', qty: 900, active: 2, delivery: 65,
    colours: ['White'], gender: 'Womens', source: 'Fitleasure - Core/Tech Packs/Hooded Tank (1).pdf' },
  { mo: 3, id: 'AER-BSW-BRA00-SS27-001', slug: 'flex-sports-bra', product: 'Flex Sports Bra', style: 'AER-FSB-12', cat: 'SPORTSBRA', mfr: 'blr', qty: 1600, active: 9, delivery: 28,
    fabric: 'Nylon-spandex double knit 240 GSM', colours: ['Black'], gender: 'Womens', source: 'Fitleasure-HIIT/Womens/FLSW04 Soft Sculpt Longline Sports Bra.pdf' },
  // ── Fleece and layers ──
  { mo: 4, id: 'AER-NCR-SWEAT-SS27-001', slug: 'core-crew-sweatshirt', product: 'Core Crew Sweatshirt', style: 'AER-CCS-13', cat: 'SWEATSHIRT', mfr: 'ncr', qty: 1000, active: 6, delivery: 48,
    fabric: 'Cotton-poly fleece 320 GSM', colours: ['Navy'], gender: 'Mens', source: 'Fitleasure-HIIT/Mens/FLSM04 Baseline Quater Zip.pdf' },
  { mo: 4, id: 'AER-NCR-CROPH-SS27-001', slug: 'cropped-fleece-hoodie', product: 'Cropped Fleece Hoodie', style: 'AER-CFH-14', cat: 'HOODIE', mfr: 'ncr', qty: 750, active: 7, delivery: 40,
    fabric: 'Cotton-poly fleece 300 GSM', colours: ['Orange'], gender: 'Womens', source: 'Fitleasure - Core/Tech Packs/FLGCM16 Recovery Joggers.pdf' },
]
