#!/usr/bin/env python3
"""生成本地测试站点 fixture：utf8site/ 与 gbksite/，各含目录页 + 3 个章节页。
模拟笔趣阁形态：杂乱布局、广告节点、水印文本、底部 上一章/目录/下一章 导航。
运行：python3 tools/gen_fixtures.py，然后 python3 -m http.server -d test/fixtures 8080
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / "test" / "fixtures"

CHAPTERS = [
    {
        "no": "第一章",
        "title": "雨夜客栈",
        "prev": None,
        "next": "2.html",
        "paras": [
            "暮色四合，秋雨绵绵，官道尽头的一家客栈亮起了灯笼。",
            "客栈门口的招幡被雨水打湿，沉甸甸地垂着，上书两个大字——悦来。",
            "林照牵马入店，抖了抖蓑衣上的雨水，环顾四周。",
            "大堂里人不多，靠窗坐着一位青衫书生，正自斟自饮。",
            "\"客官，打尖还是住店？\"小二热情地迎上来。",
            "\"一碗阳春面，一间上房。\"林照淡淡道，将一枚碎银放在柜上。",
            "书生闻声抬头，目光在林照腰间的长剑上停了一瞬，随即又低下头去。",
            "夜半，雨声渐急，林照忽然睁开眼——屋瓦上有极轻的脚步声。",
            "\"既然来了，何必藏头露尾。\"他坐起身，声音不大，却穿透雨幕。",
            "瓦上人轻笑一声：\"久闻'听雨剑'林照耳力过人，今日一见，名不虚传。\"",
            "一道黑影破窗而入，剑光如匹练般卷来，直取林照咽喉。",
            "林照侧身避过，反手一剑，剑尖在黑暗中划出一线幽光。",
            "三招过后，黑影倒纵而出，消失在雨夜之中，只留下一句：\"三日后，取你性命。\"",
            "林照收剑入鞘，望着窗外的雨幕，眉头微皱：\"血手门……终于来了。\"",
        ],
    },
    {
        "no": "第二章",
        "title": "青衫书生",
        "prev": "1.html",
        "next": "3.html",
        "paras": [
            "次日清晨，雨过天晴，客栈大堂里弥漫着面汤的香气。",
            "昨夜那位青衫书生仍坐在老位置，面前摊着一卷旧书。",
            "\"阁下昨夜可曾安睡？\"书生忽然开口，头也不抬。",
            "林照在他对面坐下：\"阁下既知有人寻仇，为何不出手相助？\"",
            "\"江湖事，江湖了。\"书生微微一笑，\"况且，那人的目标也未必是你。\"",
            "林照瞳孔微缩。书生合上书卷，露出封皮上四个古篆——山河剑经。",
            "\"传闻山河剑经出世，武林将有大乱，血手门此来，为的是它。\"",
            "\"它在你身上？\"林照沉声问。",
            "书生不答，只将书卷推到他面前：\"三日后若我还活着，自会告诉你全部。\"",
            "话音未落，客栈大门被轰然撞开，七八名黑衣人鱼贯而入。",
            "为首之人面色惨白，双掌泛着淡淡红光，正是血手门堂主赵无极。",
            "\"把剑经交出来，饶你们不死。\"赵无极阴恻恻地道。",
            "书生叹息一声，缓缓起身：\"我要的清静，终究是求不来了。\"",
        ],
    },
    {
        "no": "第三章",
        "title": "剑出如虹",
        "prev": "2.html",
        "next": "index.html",  # 尾章：下一章指回目录，应被识别为“已是最后一章”
        "paras": [
            "剑光起处，桌椅纷碎，大堂瞬间空出一片场地。",
            "赵无极双掌翻飞，红光暴涨，血手印一式重过一式。",
            "书生袖袍轻拂，身形飘忽如柳，竟在掌影间穿行自如。",
            "\"山河剑经第一式——观澜。\"书生轻叱，指剑并出。",
            "一道无形剑气横空掠过，赵无极的袖袍应声而断，露出小臂上一道血痕。",
            "\"你——你已练成了剑经？！\"赵无极又惊又怒，倒退三步。",
            "黑衣人见堂主受伤，一拥而上，刀光剑影织成一张大网。",
            "林照长剑出鞘，听雨剑法如急雨般洒落，护住书生侧翼。",
            "两人联手，不过十招，黑衣人尽数倒地，哀嚎不止。",
            "赵无极见势不妙，抓起一扇窗户纵身跃出，狼狈遁走。",
            "\"多谢兄台援手。\"书生拱手，\"在下沈青崖，敢问高姓大名。\"",
            "\"林照。\"林照还礼，目光落在那卷剑经上，\"现在，可以说了吗？\"",
            "沈青崖望向远方群山，缓缓道：\"这一切，要从二十年前那场大火说起……\"",
        ],
    },
]

FILLER = [
    "窗外雨势又急了几分，檐角的铜铃在风中轻响，声音被雨声揉得断断续续。",
    "客栈里的伙计添了灯油，昏黄的光晕在墙上晃动，把人影拉得忽长忽短。",
    "林照端起茶盏，茶汤微凉，映出他略显疲惫的面容。",
    "江湖上的事，从来都是身不由己，他早已习惯了在刀口上讨生活。",
    "远处传来更夫的梆子声，三更天了，这雨怕是要下一整夜。",
    "沈青崖的手指轻轻叩着桌面，节奏与雨声暗合，仿佛在计算着什么。",
    "\"你说，血手门为何偏偏选在此时动手？\"林照忽然问道。",
    "\"因为他们等不及了。\"沈青崖淡淡道，\"剑经现世的消息，已经传遍了五省。\"",
    "林照默然。宝物无罪，怀璧其罪，这个道理他七岁那年就懂了。",
    "那年家中大火，父亲拼死将他送出火场，自己却再没能走出来。",
    "十六年来，他四处游历，练剑，查访，就是为了查清那场大火的真相。",
    "如今线索终于浮出水面，却牵扯出了更大的漩涡。",
    "\"沈兄，\"林照抬起头，\"若剑经会给你带来杀身之祸，为何不将它毁去？\"",
    "沈青崖摇头一笑：\"剑经本身并无善恶，作恶的从来都是人心。\"",
    "\"况且，\"他顿了顿，\"这卷剑经里，还藏着一个天大的秘密，关乎二十年前武林浩劫的真相。\"",
    "林照心中一震，二十年前，正是他家破人亡的那一年。",
    "雨声中，两人的目光交汇，都从对方眼中看到了某种了然。",
    "\"原来，你也是那场浩劫的遗孤。\"沈青崖轻叹。",
    "客栈的灯火在两人之间摇曳，仿佛预示着一场即将到来的风暴。",
    "门外忽然传来马蹄声，由远及近，在雨夜中显得格外清晰。",
    "林照与沈青崖对视一眼，同时收敛了气息，屋内瞬间安静得可怕。",
    "马蹄声在店门外停下，紧接着是一阵沉重的脚步声，踏得楼板咯吱作响。",
    "\"店家，\"一个沙哑的声音在楼下响起，\"可还有空房？\"",
    "小二殷勤的应答声隐约传来，那脚步声上了楼，在走廊尽头停住。",
    "林照的耳朵微微一动——那人径直走向的，正是他们隔壁的房间。",
    "夜更深了，雨却始终没有停歇的意思。",
    "隔壁房间始终没有亮灯，静得像一间空房，但林照知道，那人在看着他们。",
    "这是一场无声的对峙，谁先沉不住气，谁就输了先手。",
    "烛火燃到尽头，爆出最后一朵灯花，屋内霎时暗了几分。",
    "新的一天快到了，而属于他们的风暴，才刚刚开始。",
]

for ch in CHAPTERS:
    if len(ch["paras"]) < 30:
        ch["paras"] = (ch["paras"] + FILLER)[:30]

WATERMARKS = [
    "最快更新最新章节！",
    "请记住本书首发站点：booktest.local",
    "一秒记住本站地址 www.booktest.local",
    "本章完，点击下一页继续阅读",
    "手机阅读请访问 m.booktest.local 无弹窗广告",
]

ADS = [
    '<div class="ad">【广告】传奇霸业，今晚就攻沙！点击领取新手大礼包</div>',
    '<div id="HMRichBox"><a href="https://ad.invalid/coupon">限时优惠，一刀999级</a></div>',
    # 同源 404 + async：保留 script/img 标签供提取清洗测试，但不阻塞 HTML 解析（外链挂起会卡住 document_idle）
    '<script async src="/cpro.js"></script>',
    '<div class="ads"><img src="/banner.png" alt="广告" /></div>',
]


def chapter_page(site_title: str, ch: dict, encoding_name: str) -> str:
    ads_inline = "".join(ADS)
    # 在正文中插入水印与广告段落
    body_parts = []
    for i, para in enumerate(ch["paras"]):
        body_parts.append(para)
        if i == 4:
            body_parts.append(WATERMARKS[0])
            body_parts.append("www.booktest.local")
        if i == 8:
            body_parts.append(WATERMARKS[2])
        if i == 11:
            body_parts.append(WATERMARKS[1])
    content = "<br/><br/>".join(body_parts)

    prev_link = (
        f'<a href="{ch["prev"]}">上一章</a>' if ch["prev"] else '<a href="index.html">目录</a>'
    )
    next_text = "下一章" if ch["next"] != "index.html" else "返回目录"

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="{encoding_name}" />
<title>{ch["no"]} {ch["title"]}_{site_title}_笔趣阁</title>
</head>
<body>
<div class="header"><h1><a href="index.html">{site_title}</a></h1></div>
<div class="nav">首页 | 书库 | 排行榜 | 完本小说</div>
{ads_inline}
<div class="bookname"><h2>{ch["no"]} {ch["title"]}</h2></div>
<div id="content">
{content}
</div>
{ads_inline}
<div class="bottem1">
{prev_link} <a href="index.html">返回目录</a> <a href="{ch["next"]}">{next_text}</a>
</div>
<div class="footer">Copyright © booktest.local {site_title} All Rights Reserved.</div>
</body>
</html>
"""


def index_page(site_title: str) -> str:
    items = "".join(
        f'<li><a href="{i + 1}.html">{c["no"]} {c["title"]}</a></li>'
        for i, c in enumerate(CHAPTERS)
    )
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>{site_title}最新章节目录_笔趣阁</title>
</head>
<body>
<div class="header"><h1><a href="index.html">{site_title}</a></h1></div>
<div id="list"><h2>章节目录</h2><ul>{items}</ul></div>
<div class="footer">Copyright © booktest.local</div>
</body>
</html>
"""


def write(path: Path, text: str, encoding: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(text.encode(encoding, errors="replace"))
    print(f"wrote {path.relative_to(ROOT)} ({encoding})")


def main():
    # UTF-8 站
    (FIX / "utf8site" / "index.html").write_text(index_page("山河剑经"), encoding="utf-8")
    for i, ch in enumerate(CHAPTERS):
        write(FIX / "utf8site" / f"{i + 1}.html", chapter_page("山河剑经", ch, "utf-8"), "utf-8")
    # GBK 站（大量老站默认编码）
    (FIX / "gbksite" / "index.html").write_text(index_page("听雨剑歌"), encoding="utf-8")
    for i, ch in enumerate(CHAPTERS):
        write(FIX / "gbksite" / f"{i + 1}.html", chapter_page("听雨剑歌", ch, "gbk"), "gbk")
    print("done. serve with: python3 -m http.server -d test/fixtures 8080")


if __name__ == "__main__":
    main()
