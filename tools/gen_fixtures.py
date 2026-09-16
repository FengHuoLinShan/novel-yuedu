#!/usr/bin/env python3
"""生成本地测试站点 fixture：utf8site/ 与 gbksite/，各含目录页 + 3 个章节页；longsite/ 含 16 章（连读/收起回归）；
pagesite/ 为分页式站点（8 章每章 2 分页，整本持久缓存 e2e 用）。
模拟笔趣阁形态：杂乱布局、广告节点、水印文本、底部 上一章/目录/下一章 导航。
运行：python3 tools/gen_fixtures.py，然后 python3 -m http.server -d test/fixtures 8080
"""
import re
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

# 长连读站点：16 章用于触发 DOM 章节数超限后的收起（_trimChapters）回归测试
LONG_COUNT = 16
LONG_CHAPTERS = [
    {
        "no": f"第{i}章",
        "title": f"连读测试{i:02d}",
        "prev": None if i == 1 else f"{i - 1}.html",
        "next": "index.html" if i == LONG_COUNT else f"{i + 1}.html",
        "paras": [f"（第{i}章开篇）长夜未央，客栈里的灯又亮了一晚。"] + FILLER[:29],
    }
    for i in range(1, LONG_COUNT + 1)
]

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


def index_page(site_title: str, chapters: list) -> str:
    items = "".join(
        f'<li><a href="{i + 1}.html">{c["no"]} {c["title"]}</a></li>'
        for i, c in enumerate(chapters)
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


# 分页式站点（pagesite）：8 章每章 2 分页共 16 页，用于整本持久缓存 e2e（断点续抓/离线供章）。
# 章节页 #main > h1 + .content（每页 ≥8 个 <p>、CJK ≥450，保证 minCjk=400 浮球判定通过）；
# 底部 .page 导航三链接：上一页（各章首页用 javascript:void(0)）/ catalog.html 目录 / 下一页；
# 尾页 8_2.html 不输出下一页链接 → 抓取链自然终止（books.done=true）。
# 尾页刻意做成"章末短分页"（CJK 120~300 + 竖线混淆提示行）：分页式站点（如 1qxs）的章末页
# 只有一两百字，低于默认提取门槛会熔断整本链；getChapter 的 minCjk=120 必须放行它。
PAGESITE_BOOK = "镜华录"
PAGESITE_CHAPTERS = [
    ("第1章", "雾锁渡口"),
    ("第2章", "灯影疑云"),
    ("第3章", "夜探货栈"),
    ("第4章", "血字木牌"),
    ("第5章", "双镜奇缘"),
    ("第6章", "水落石出"),
    ("第7章", "旧约重提"),
    ("第8章", "潮平岸阔"),
]
PAGESITE_WATERMARK = "【测试书名】小说免费阅读，请收藏　示例站【example.com】"
PAGESITE_PIPE_NOTICE = "阅|读|模|式|或|畅|读|模|式|下，无|法|显|示|本|章|节|全|部|内|容，请|返|回|原|网|页阅|读。"
PAGESITE_PARAS = [
    "暮色沉进江面的时候，渡口的青石阶被水汽浸得发亮，艄公把缆绳在木桩上又绕了一圈。",
    "对岸的山影被雾揉成一团淡墨，只有半山那盏灯还亮着，像谁忘了吹熄的蜡烛。",
    "她把油纸伞收在门后，伞尖滴下的水在青砖上积成一小滩，映出半张疲惫的脸。",
    "柜台后的掌柜抬起眼皮扫了她一眼，又低头拨弄算盘，珠子声在空荡的大堂里格外清脆。",
    "墙上的告示被风掀起一角，浆糊干透的边缘哗啦作响，字迹已经被潮气晕开了。",
    "后院传来劈柴声，一下一下，不紧不慢，像是给这雾夜数着更次。",
    "灶膛里的火光忽明忽暗，煨着的药罐咕嘟作响，苦味混着水汽漫过半个院子。",
    "远处传来一声橹响，又很快被雾吞没，只有涟漪一层层推到岸边，碰碎了灯的倒影。",
    "他把信纸折成三折塞回封套，火漆上的印痕已经被拇指磨得模糊，认不出是谁的家徽。",
    "更夫的梆子敲过三巡，巷子深处的犬吠此起彼伏，又被一声叱喝镇了下去。",
    "桌上的茶早就凉透了，水面浮着一层薄薄的白气，像谁叹息之后留下的痕迹。",
    "夜航的船灯在雾里晕成一团团黄斑，忽远忽近，仿佛整条江都在慢慢地呼吸。",
    "她数着廊柱走过长街，每一步都踩在灯影的缝隙里，像是要把来路从记忆中删去。",
    "货栈的门缝里透出一线光，人语声压得极低，偶尔夹着金属轻轻磕碰的脆响。",
    "雨点开始敲打瓦当，先是零星几声，随即连成一片，把整座镇子裹进水声里。",
    "他把铜镜翻过来，背面錾着的云纹已经磨损，唯有边缘那道刻痕还清晰如昨。",
]
_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")


def pagesite_page_paras(ch_no: str, ch_title: str, page_no: int, short: bool = False) -> list:
    """单页正文段落：水印行打头 + 章节开场行 + 填充段；断言 CJK ≥450、段落 ≥8（生成期自检）。

    short=True 生成章末短分页：CJK 120~300（高于 getChapter 的 minCjk=120、低于默认 300），
    并插入竖线混淆提示行（cleaner 必须整行过滤，否则会以乱码段落入库）。
    """
    paras = [
        PAGESITE_WATERMARK,
        f"{ch_no} {ch_title}（{page_no}/2）：夜航的汽笛声隔着雾传来，闷闷的，像谁在江底敲门。",
    ]
    if short:
        paras.append(PAGESITE_PIPE_NOTICE)
        paras.append(PAGESITE_PARAS[0])
        paras.append(PAGESITE_PARAS[3])
        body_cjk = len(_CJK_RE.findall("".join(paras)))
        assert 120 < body_cjk < 300, f"pagesite 短分页 CJK 应在 (120,300)：{ch_no} p{page_no} = {body_cjk}"
        assert len(paras) >= 4, f"pagesite 短分页段落不足 4：{ch_no} p{page_no}"
        return paras
    i = (page_no - 1) * 5
    while len(paras) < 16:
        paras.append(PAGESITE_PARAS[i % len(PAGESITE_PARAS)])
        i += 1
    body_cjk = len(_CJK_RE.findall("".join(paras)))
    assert body_cjk >= 450, f"pagesite 正文 CJK 不足 450：{ch_no} p{page_no} = {body_cjk}"
    assert len(paras) >= 8, f"pagesite 正文段落不足 8：{ch_no} p{page_no}"
    return paras


def pagesite_page(ch_no: str, ch_title: str, n: int, page_no: int, total_ch: int) -> str:
    is_first_page = page_no == 1
    # 上一页：各章首页用 javascript:void(0)（非 http 链接会被导航识别忽略），其余指前一分页
    prev_href = "javascript:void(0)" if is_first_page else f"{n}.html"
    # 下一页：本章第 1 页 → 本页第 2 分页；第 2 分页 → 下一章首页；末章末页不输出（链自然终止）
    has_next = not (n == total_ch and page_no == 2)
    next_href = f"{n}_2.html" if is_first_page else f"{n + 1}.html"
    next_link = f'<a href="{next_href}">下一页</a>' if has_next else ""
    paras = pagesite_page_paras(ch_no, ch_title, page_no, short=not has_next)
    para_ps = "".join(f"<p>{t}</p>\n" for t in paras)
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>{PAGESITE_BOOK}_{ch_no} {ch_title}({page_no}/2)</title>
</head>
<body>
<div id="main">
<h1>{ch_no} {ch_title}({page_no}/2)</h1>
<div class="content">
{para_ps}
</div>
</div>
<div class="page">
<a href="{prev_href}">上一页</a> <a href="catalog.html">目录</a> {next_link}
</div>
<div class="footer">{PAGESITE_BOOK} 示例站页面，仅供本地扩展测试使用</div>
</body>
</html>
"""


def pagesite_catalog() -> str:
    items = "".join(
        f'<li><a href="{n}.html">{ch_no} {ch_title}</a></li>\n'
        for n, (ch_no, ch_title) in enumerate(PAGESITE_CHAPTERS, start=1)
    )
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>{PAGESITE_BOOK}最新章节目录_示例站</title>
</head>
<body>
<div class="header"><h1>{PAGESITE_BOOK}</h1></div>
<div id="list">
<h2>章节目录</h2>
<ul>
{items}
</ul>
</div>
<div class="footer">{PAGESITE_BOOK} 示例站页面，仅供本地扩展测试使用</div>
</body>
</html>
"""


def main():
    # UTF-8 站
    (FIX / "utf8site" / "index.html").write_text(index_page("山河剑经", CHAPTERS), encoding="utf-8")
    for i, ch in enumerate(CHAPTERS):
        write(FIX / "utf8site" / f"{i + 1}.html", chapter_page("山河剑经", ch, "utf-8"), "utf-8")
    # GBK 站（大量老站默认编码）
    (FIX / "gbksite" / "index.html").write_text(index_page("听雨剑歌", CHAPTERS), encoding="utf-8")
    for i, ch in enumerate(CHAPTERS):
        write(FIX / "gbksite" / f"{i + 1}.html", chapter_page("听雨剑歌", ch, "gbk"), "gbk")
    # 长连读站（16 章，UTF-8）：驱动滚动拼接直到触发章节收起
    write(FIX / "longsite" / "index.html", index_page("长夜十六更", LONG_CHAPTERS), "utf-8")
    for i, ch in enumerate(LONG_CHAPTERS):
        write(FIX / "longsite" / f"{i + 1}.html", chapter_page("长夜十六更", ch, "utf-8"), "utf-8")
    # 静态 JS 探针：e2e-adguard 用 <script src> 探测 DNR 对 script 类型请求的拦截/放行
    # （html 当 script 会被浏览器按 MIME 拒执行，onerror 与拦截不可区分，必须用真 .js）
    write(FIX / "adstub.js", "// e2e-adguard script 探针（内容无需副作用）\n", "utf-8")
    # 分页式站点（8 章每章 2 分页共 16 页）：整本持久缓存 e2e 用，UTF-8
    write(FIX / "pagesite" / "catalog.html", pagesite_catalog(), "utf-8")
    for n, (ch_no, ch_title) in enumerate(PAGESITE_CHAPTERS, start=1):
        for page_no in (1, 2):
            name = f"{n}.html" if page_no == 1 else f"{n}_{page_no}.html"
            write(FIX / "pagesite" / name, pagesite_page(ch_no, ch_title, n, page_no, len(PAGESITE_CHAPTERS)), "utf-8")
    print("done. serve with: python3 -m http.server -d test/fixtures 8080")


if __name__ == "__main__":
    main()
