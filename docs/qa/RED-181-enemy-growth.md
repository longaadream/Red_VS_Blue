# 每十个世界回合敌人成长

完成10/20/30轮后，未交战存活敌人每级增加初始生命20%与攻击1；保留伤势、战斗冻结、联机公共轮次、跨幕累计、存档幂等。资源配置enemyGrowth，世界扩展保存completedRoundOffset与enemyLevels，UI显示等级。

5个相关测试文件共41项通过，包括实际commit、跨幕、checkpoint读回；ESLint与引擎构建通过，HTML内联脚本语法通过。类型检查仍仅既有editor TS2345。独立只读审查无新增阻塞；已补建议的跨幕与checkpoint回归。远端fetch连接失败，未推送、提交或发布。
