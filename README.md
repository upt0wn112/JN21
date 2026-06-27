# Back in Print Product Gallery

A small product catalog and admin app for Back in Print item photos.

## Update photos

Add item photos to `01_ITEM_PHOTOS`, then run:

```powershell
powershell -ExecutionPolicy Bypass -File .\refresh-photos.ps1
```

The refresh script updates `products.csv`, `public/js/photo-manifest.js`, and `public/js/products-data.js`.
