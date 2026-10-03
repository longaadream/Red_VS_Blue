# 无惨头像生成记录

使用内置 `image_gen`，2026-09-26。用户提供角色参考图；风格参考为仓库 `public/aizen.jpg` 和 `public/ulquiorra.jpg`。生成后目视检查红眼、卷发、帽子、面部辨识度及棕褐纸张/块面阴影风格。未使用 CLI 或后期绘图脚本。

项目资源：`public/muzan.png`、`public/images/muzan.png`、`data/pages/images/muzan.png`（相同 PNG 字节）。角色 `dark-muzan` 引用 `muzan.png`。

## 最终提示词

Use case: style-transfer. Create ONE finished square game character portrait asset of 鬼舞辻无惨 (Muzan Kibutsuji), no text. Input image 1 is the character identity reference: preserve his recognizable pale face, ominous red eyes, black curled sidelocks, fedora hat silhouette and dark high-collared suit. Images 2 and 3 are STYLE references from the actual game roster, not extra characters. Match those roster portraits closely: bold near-black ink contours, crisp angular faceted cel-shaded planes, restrained warm parchment tan/ochre and charcoal palette, subtle grainy paper texture, flat textured warm brown background, illustrated tabletop character-card aesthetic. Recompose the first image into a centered head-and-upper-shoulders portrait, subtle three-quarter view, cold composed expression. Hat may occupy the top but must not obscure the red eyes or turn the face into an unreadable black silhouette; keep facial planes clearly legible at 48px circular icon size. Keep face centered and all identity features inside a safe central circular crop; shoulders extend naturally to bottom edges. Match detail density and framing of image 3. No extra props, no action scene, no blood, no lettering, no logos, no border, no circular frame, no watermark, no collage. Full opaque square image, 1024x1024.
