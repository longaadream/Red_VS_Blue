# 统一头像美术制作记录

生成方式：内置 ImageGen；未使用 API/CLI 回退。图片修正也由 ImageGen 完成。`package-portraits.cjs` 仅使用已有 sharp 依赖压缩尺寸和编码，不进行美术重绘。原图可从 main 基线恢复。

## 公共提示词

Use case: style-transfer. Redraw the character in the existing avatar as one finished square game portrait. The original avatar is the identity reference: retain recognizable face, costume, hair, species, age and facial markings. The generated Ana portrait is STYLE ONLY: bold American comic ink outlines, chunky angular cel-shadow planes, expressive simplified anatomy, restrained paper grain, muted warm colors and a plain warm taupe backdrop. Do not import Ana or her clothing. Head and upper shoulders centered at eye level, readable at 64 pixels, keep the head within the image for circular cropping. No writing, border, watermark, photorealism or 3D rendering. Preserve only physical features visible in the identity reference; do not add new ornaments or anatomy.

第一张安娜使用其旧头像，按上述风格独立生成；后续角色以安娜成图作为画风参考。部分原图为全身，成图改为头像构图。

## 修正约束

佐助、拉法姆、带土、鼬、飞段去除新增的角状装饰，修复对应头发、绷带或背景；蓝染去除眼下十字，恢复无标记皮肤。其余脸部、服装、构图和色彩保持不变。逐角色的精确修正提示词、最后一批主体提示词及生成文件名保存在 `portraits.json`。

毒液的生成与一次简化重试均被工具拦截，未交付新头像。不能将其他角色头像或占位图冒充毒液。

## 后续开发者维护

同一角色继续使用 `data/pieces/*.json` 的 `image` 文件名；新增 IP 只需新增头像资源，不需要改卡面或棋子渲染接口。建议使用 512×512 的头肩图、统一暖灰背景、强轮廓和清楚的身份特征。交付前在 64px 圆形裁切下检查辨识度，尤其避免凭空添加角、面纹或服装配件。
