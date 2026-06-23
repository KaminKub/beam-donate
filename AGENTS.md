# UI/UX Guidelines for Beam Donate

## Icon System: Font Awesome First

When adding, modifying, or editing any UI elements (icons, buttons, menus, modals, status indicators, etc.):

1. **Always use Font Awesome (fa-solid / fa-regular / fa-brands) icons as the primary choice.**
   - The project already includes Font Awesome 6.4.2 Free CDN.
   - Use `<i class="fa-solid fa-icon-name"></i>` pattern.
   - For brand icons (Twitch, YouTube, TikTok, etc.), use `<i class="fa-brands fa-icon-name"></i>`.

2. **Only fall back to Emoji characters if no suitable Font Awesome icon exists.**
   - Check the Font Awesome 6 Free icon library first.
   - Emoji should be the last resort, not the default.

3. **Never use Emoji as primary UI icons** — this includes:
   - Sidebar menu icons
   - Section/panel headers
   - Button decorations
   - Stat/metric card icons
   - Modal/title icons
   - Status indicators
   - Notification icons
   - Warning/info labels

4. **Exceptions where Emoji is acceptable:**
   - Inside user-generated content or placeholder text
   - Inside configurable template fields (e.g., message templates)
   - Decorative text within descriptions (e.g., option labels like "แปลงเป็นคำน่ารัก 🌸")

## Verification

After making UI changes, always verify:
- Font Awesome icons render correctly (not as empty squares)
- The icon name is valid in Font Awesome 6 Free (not a Pro-only icon)
- CSS adjustments are added if needed (e.g., `line-height: 1` for icons inside flex containers)

## Icon Colors

5. **Always add distinct colors to Font Awesome icons** — never leave them as plain inherited text color:
   - Use semantic colors: green for success/check, red for error/danger, blue for info/link, amber/gold for warning/payment, purple for creative, cyan for media, etc.
   - Use CSS class selectors like `.settings-card-header h4 .fa-image { color: #22d3ee; }`
   - Icons inside styled buttons (`.btn-primary`, `.btn-secondary`) may inherit button colors if already well-styled.

## Refresh / Reload Buttons

6. **All refresh or reload buttons MUST follow the spinning arrow pattern** modeled after `.btn-sync-promptpay`:
   ```css
   .btn-reload-preview {
     display: inline-flex;
     align-items: center;
     gap: 8px;
     padding: 10px 18px;
     background: rgba(255, 255, 255, 0.06);
     border: 1px solid rgba(255, 255, 255, 0.15);
     border-radius: 10px;
     color: #e2e8f0;
     font-size: 13px;
     font-weight: 500;
     cursor: pointer;
     transition: all 0.25s ease;
     font-family: inherit;
     backdrop-filter: blur(6px);
   }
   .btn-reload-preview:hover {
     background: rgba(255, 255, 255, 0.12);
     border-color: rgba(255, 255, 255, 0.3);
     color: #ffffff;
     box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
   }
   .btn-reload-preview i {
     font-size: 13px;
     transition: transform 0.35s ease;
   }
   .btn-reload-preview:hover i {
     transform: rotate(180deg);
   }
   .btn-reload-preview.spinning {
     pointer-events: none;
     opacity: 0.8;
   }
   .btn-reload-preview.spinning i {
     animation: reloadSpin 1s linear infinite;
   }
   @keyframes reloadSpin {
     from { transform: rotate(0deg); }
     to { transform: rotate(360deg); }
   }
   ```
   - Use `<i class="fa-solid fa-rotate"></i>` as the icon.
   - The icon tilts 180° on hover (gentle, not full 360°).
   - On click: add class `.spinning` to trigger continuous slow spin (1s per rotation), remove after ~1.2s.
   - Use `.btn-reload-*` class naming convention for new reload buttons.
   - Always wire the click handler to add/remove `.spinning` for loading feedback.
