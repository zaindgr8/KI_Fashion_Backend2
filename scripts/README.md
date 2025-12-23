# Database Seeding Scripts

This folder contains scripts to seed the database with initial data.

## Product Types Seeding

Seeds the database with common fashion product types for suppliers to use.

### Usage

**First time seeding:**
```bash
npm run seed:product-types
```

**Force reseed (deletes existing product types):**
```bash
npm run seed:product-types:force
```

### What gets seeded

The script creates 12 common product types:

1. **Denim Jeans** - Denim pants and jeans in various styles
2. **T-Shirts** - Casual t-shirts and tops
3. **Jackets** - Outerwear jackets and coats
4. **Shirts** - Formal and casual shirts
5. **Hoodies & Sweatshirts** - Casual hoodies and sweatshirts
6. **Dresses** - Women's dresses in various styles
7. **Skirts** - Women's skirts
8. **Shorts** - Casual and athletic shorts
9. **Activewear** - Sports and fitness clothing
10. **Sweaters & Cardigans** - Knit sweaters and cardigans
11. **Accessories** - Fashion accessories
12. **Footwear** - Shoes and sandals

Each product type includes relevant attributes for better product categorization.

### Notes

- The script will create a system admin user if none exists
- Existing product types are preserved unless `--force` flag is used
- All product types are marked as active by default
