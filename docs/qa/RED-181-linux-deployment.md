# RED-181 Linux 联机服务部署

base_branch: main
base_sha: ebe47eee059d18b5282856759a1a04edbc553d67

用户已批准在新购 Ubuntu 24.04 服务器上通过本机 SSH 密钥协助部署。沿用当前分支，保留未提交的入口修复；按用户既有要求使用本地合同，不再发送 Linear。

目标：使用同一 Colyseus 权威提供 PVP / PVE 休闲房间，PostgreSQL 持久化；公网入口使用 HTTPS/WSS。风险 High，部署方案经用户批准。范围为 scripts/Linux 打包与部署工具、config/linux、本文和对应验证；不更改规则、存档格式、签名、排名服务或现有客户端资源包，不发布 Release 或合并 PR。

打包需携带与客户端一致的内容身份，排除本地用户数据、密钥和 node_modules。服务以独立低权限用户运行，PostgreSQL 仅供本机使用；服务端构建在本机完成。部署使用独立版本目录，保留旧版本；更新前备份数据库，回退切换旧目录，禁止旧代码直接运行于不兼容数据库。

验收：包文件 SHA-256 清单可验证，内容 Profile 与源目录一致；Linux 进程可启动、健康检查正常；两个真实 SDK 客户端可建立 PVP / PVE 房间；节点存档与重启恢复可验证；域名证书和公网 WSS 通过后再交付公网入口。独立审查及实际测试均需记录，不以打包成功代替联机验收。

当前：SSH 已验证。候选子域名 play.redvsblue.top，DNS 由腾讯云管理，尚待用户配置。服务器实际位于上海，公网域名接入还需确认备案状态。暂未部署或开放服务。

## 香港节点实际部署（替代上方上海计划）
2026-09-15：用户改购香港 38.22.90.175，Ubuntu24.04/4GB；play.redvsblue.top 已解析，已授权免费证书条款与自动续期。
候选 candidate-qtLOrq：21828e17904bb2a69ba3e70b2152f2e96841e0ebe0b56aff7e69a3d0df3684a3。远程 /opt/rvb/releases/candidate-qtLOrq 清单通过；Node24.21.0官方SHA256验证通过。
rvb-game 为独立rvb用户，PG socket peer连接，5432与2567仅本机监听。USER_DATA_DIR=/var/lib/rvb、APP_ROOT_DIR=/opt/rvb/current；独立审查发现数据目录缺失后已修复并重启。
真实SDK通过SSH隧道：1v1两人、2v2四人、PVE两人建房/加入/列表通过。尚未验证完整对局、存档恢复。服务重启后健康检查正常。
初始备份：/var/backups/rvb/initial-tested.dump，仅本机备份非异地灾备。恢复诊断：systemctl restart rvb-game；journalctl -u rvb-game。
当前证书申请等待系统unattended-upgrades下载linux-firmware完成，不强制终止apt；HTTPS尚未启用。未修改客户端默认地址、未打包或发布。

HTTPS已启用：2026-09-15申请成功，证书到期2026-12-13；certbot.timer自动续期，deploy hook校验并reload nginx。443代理至127.0.0.1:2567，80除ACME验证外重定向HTTPS。
系统首次自动更新下载完后逐批安装很慢，已核实程序SIGTERM为优雅停止标记，安全结束当前批次后释放锁；未禁用自动更新。随后certbot安装和证书签发成功。
公网 https://play.redvsblue.top 真实SDK验证：1v1两人、2v2四人、PVE两人创建/加入/列表全部通过；PVE开局与保存检查点通过。

最终验证：certbot renew --dry-run通过；系统重启后rvb-game/nginx/postgresql/certbot.timer全部active，HTTPS healthz正常，dpkg --audit无输出。重启前备份 /var/backups/rvb/before-first-reboot.dump。客户端尚未预设此入口，未打包。

## 普通房间改为玩家本机权威
已部署独立 rvb-relay.service，127.0.0.1:8080；nginx仅将 /hosts、/invites、/publish 转发到该进程。转发不运行游戏规则、不存档、不接受远端create/管理路径。根路由现仍保留旧rvb-game，待官方排位部署后切换，尚未移除旧测试服务。
公网真实测试：本地PVE房主、经play.redvsblue.top转发客机，列表/准备/开局/保存权限/恢复通过。服务为rvb低权限用户、限连接/消息大小，X-Real-IP仅信任回环代理。配置源config/linux/rvb-relay.service，构建scripts/build-linux-relay.mjs。
回退：停止rvb-relay、将 /opt/rvb/nginx-before-relay.conf 恢复到 /etc/nginx/sites-available/rvb-game，nginx -t后reload。不要关闭原rvb-game或删除数据库。
Linux官方排位启动器已接入build-linux-room-server.mjs：candidate-uxAwxw，451文件，profile仍21828e17904bb2a69ba3e70b2152f2e96841e0ebe0b56aff7e69a3d0df3684a3。未部署。
运行需APP_ROOT_DIR指候选、USER_DATA_DIR指独立可写官方数据目录、RVB_POSTGRES_URL指独立排位数据库、RVB_SMTP_CONFIG指候选外私有JSON（host/port/user/password/from）。先验证SMTP再启动；当前用户尚待本机填写邮件配置，禁止把授权码提交仓库或输出到日志。现有玩家库不可直接当排位账号库使用。下一步需邮件配置、独立DB、nginx官方路由与实际注册/匹配验收。

## 本机服务器管理工具
用户授权实现脚本与可视化界面。High；base_branch main，base_sha ebe47eee059d18b5282856759a1a04edbc553d67。范围 scripts/server-admin、对应测试与本文。通过本机 SSH 管理，HTTP仅回环监听并校验会话令牌。支持状态、日志、数据库备份、候选上传、停服切换与失败回退；不做数据库迁移、不自动部署排位、不变更密钥。验收：输入校验、请求认证、构建清单校验、操作串行及界面冒烟；不以模拟测试宣称公网部署完成。
- 管理工具已实现于 scripts/server-admin；4项测试与ESLint通过，1280px/390px页面检查通过。新脚本真实SSH status返回rvb-game active和candidate-qtLOrq。未执行线上备份/上传/切换。独立审查三项（恢复未stop、trap注册晚、生效ExecStart校验）已修并加入模拟失败路径测试。

用户要求保留旧完整面板：根入口复用official/panel八栏目，/ops挂运维和SSH回环面板连接。新增代理严格限制路由，保留本机Origin/bearer，远程令牌仅内存/SSH stdin。独立复查指出超时不一致，已将代理超时调到315秒。浏览器八栏目/往返导航无JS异常；真实运营服务尚未部署，未伪造数据。

## 官方指挥台独立部署
用户授权重新部署。candidate-MPdo4n 470文件清单通过；独立rvb_official数据库、rvb-official.service，USER_DATA_DIR=/var/lib/rvb-official（700）。服务端面板地址存control-panel.url（600），本机connect-panel通过SSH自动发现，无需手填端口令牌。无SMTP时自动维护开启。真实代理snapshot 200，maintenance=true/accounts=0/mail.connected=false。原game/relay保持运行。未修改nginx公网路由，玩家排位尚未公开。Linux恢复仍需专门实现；SMTP可通过面板验证保存。官方面板6测试和本机管理5测试通过，初次沙箱PG启动失败后正常权限复验通过。首次上传所有权造成CHDIR，已修为rvb可读。回退：停用rvb-official，保留独立数据库和state；原服务未变更。
- 修复页面刷新丢失管理会话：令牌仅保留在当前源的sessionStorage，仍从地址清除；关闭标签页后结束。真实浏览器验证指挥台刷新、运维刷新、SSH状态查询与返回指挥台全部通过。

用户明确批准公网上游切换后，Nginx默认proxy_pass由2567改为2568，/hosts /invites /publish仍为8080；配置校验和平滑reload通过。备份/opt/rvb/nginx-before-official-public.conf。公网/official/info、/official/leaderboard、/hosts均200 JSON。未重部署程序、未停止服务、未解除排位维护。
