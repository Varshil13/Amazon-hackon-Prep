# Amazon Product Design System (`design.md`)

Based on the brand analysis of `image_25f568.jpg` and `image_25f52f.jpg`, this document outlines the exact color typography token specifications to build a Next.js product matching the Amazon ecosystem.

---

## 1. Color Palette Tokens

These tokens should be mapped into your Next.js project (e.g., `tailwind.config.js` or global CSS variables).

### Core Brand Colors
| Token Name | Hex Code | Visual Reference Location | Usage |
| :--- | :--- | :--- | :--- |
| `amazon-black` | `#131921` | Main Navigation bar (`image_25f568.jpg`) | Primary headers, nav backgrounds, main text |
| `amazon-navy` | `#232F3E` | Sub-navigation & Top Footers (`image_25f52f.jpg`) | Filter bars, secondary headers, footer top row |
| `amazon-orange` | `#FF9900` | Logo Smile / Active Elements (`image_25f568.jpg`) | Highlighting, ratings, primary accent borders |
| `amazon-yellow` | `#FEBD69` | Search Button Accent (`image_25f568.jpg`) | Primary CTA backgrounds, high-conversion action items |
| `amazon-dark-blue`| `#1A2530` | Bottom Footer (`image_25f52f.jpg`) | Legal notes background, deep canvas sections |

### Backgrounds & Neutrals
| Token Name | Hex Code | Visual Reference Location | Usage |
| :--- | :--- | :--- | :--- |
| `bg-main` | `#E3E6E6` | Main Content Wrapper (`image_25f568.jpg`) | Main page canvas layout background |
| `bg-card` | `#FFFFFF` | Product Grid Tiles (`image_25f568.jpg`) | Content cards, grid boxes, product details containers |
| `text-primary`| `#0F1111` | Product Titles / Headings (`image_25f568.jpg`)| Primary high-contrast typography font color |
| `text-link` | `#007185` | "See more deals" links (`image_25f568.jpg`) | Anchor tags, interactive inline text elements |

---

## 2. Typography Strategy

Amazon uses a clean, highly scannable sans-serif system to optimize readability across densely packed data grids.

* **Primary Font Stack:** `Amazon Ember`, `Arial`, `sans-serif`.
  * *Next.js implementation:* Since `Amazon Ember` is proprietary, configure `Arial` or a highly legible neo-grotesque alternative as the local fallback using `next/font/local`.
* **Font Weights:**
  * **Regular (`400`):** Used for standard item descriptions and subtle UI strings.
  * **Medium/Bold (`700`):** Used for item box header categories (e.g., "Pick up where you left off" in `image_25f568.jpg`) and pricing indicators.

---

## 3. UI Structural Framework

To keep elements consistent with the screenshots provided, enforce the following core structural rules:

* **Grid Layouts:** Card collections are structured as equal-height, white-background panels (`#FFFFFF`) with uniform paddings (`padding: 20px`) and square edges.
* **Component Borders:** Card panels do not use distinct dark borders; they rely on contrast against the `#E3E6E6` global background canvas to create boundaries.
* **Interactive Controls:** Search triggers use standard hard, unrounded edge configurations with the highlight color block (`#FEBD69`) pinned directly to the field wrapper.

---

## 4. Next.js Tailwind Integration Config

To apply this theme directly into a Next.js project layout seamlessly, include these values within your configuration file:

```javascript
// tailwind.config.js
module.exports = {
  theme: {
    extend: {
      colors: {
        amazon: {
          black: '#131921',
          navy: '#232F3E',
          orange: '#FF9900',
          yellow: '#FEBD69',
          darkBlue: '#1A2530',
          bgGrey: '#E3E6E6',
          textMain: '#0F1111',
          linkBlue: '#007185',
        }
      },
      fontFamily: {
        sans: ['Amazon Ember', 'Arial', 'sans-serif'],
      },
    },
  },
}