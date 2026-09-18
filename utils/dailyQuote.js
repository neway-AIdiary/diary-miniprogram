/**
 * 每日一签（dailyQuote）—— 侧栏文化推广位的内容唯一来源
 *
 * 定位：不作学习工具，只做「随手一瞥」的文化气息点缀（侧栏卡片两行 + 全篇页）。
 *
 * 契约：
 *   - 数据全部本地内置（离线可用、零域名、零审核）；日后若要云端运营，
 *     只需换掉 QUOTES 的来源，getToday/getDetail 的返回结构保持不变。
 *   - 全篇正文一律「完整收录」，不做节选；单条正文 ≤ MAX_LEN 字（300）。
 *   - 轮换按「本地日期」确定性取模：全国用户同一天看到同一条（日签仪式感），
 *     不依赖网络、不依赖随机数，跨天自动换，同一天多次调用结果恒定。
 *   - 纯函数：不碰 setData / wx.*，可被 tools/test_daily_quote.js 直接单测。
 *
 * 字段口径：
 *   诗词 → title（诗词名） / author / dynasty（朝代） / text
 *   名言 → author（作者） / origin（国别，可空） / from（出处，可空） / text
 *   卡片第一行：诗词取 title，名言取 author（用户定义）
 *   卡片第二行：正文前 PREVIEW_LEN 字 + 省略号（超长才加）
 */

// 计字与截断口径
const MAX_LEN = 300      // 单条正文上限（去空白后计字）；超过即视为池子污染
const PREVIEW_LEN = 16   // 卡片第二行预览字数

// 轮换纪元：2026-01-01（UTC 零点取「本地年月日」的序号差，跨天在本地 0 点翻页）
const EPOCH = Date.UTC(2026, 0, 1)
const DAY_MS = 24 * 60 * 60 * 1000

// 卡片图标：图标字体（icon.wxss）当前共 28 枚，书籍类只有这一枚，诗词/名言共用
const ICON = 'ri-book-open-line'

// ===== 内容池：70 首古诗词 + 10 条中国古典格言 + 20 条外国名言 = 100 条 =====
// 收录原则：古诗词与古典格言均为公有领域；外国名言取流传已久、译法通行的短句
const QUOTES = [
  // ---------- 唐诗（一）----------
  { type: 'poem', title: '静夜思', author: '李白', dynasty: '唐', text: '床前明月光，疑是地上霜。举头望明月，低头思故乡。' },
  { type: 'poem', title: '登鹳雀楼', author: '王之涣', dynasty: '唐', text: '白日依山尽，黄河入海流。欲穷千里目，更上一层楼。' },
  { type: 'poem', title: '春晓', author: '孟浩然', dynasty: '唐', text: '春眠不觉晓，处处闻啼鸟。夜来风雨声，花落知多少。' },
  { type: 'poem', title: '相思', author: '王维', dynasty: '唐', text: '红豆生南国，春来发几枝。愿君多采撷，此物最相思。' },
  { type: 'poem', title: '鹿柴', author: '王维', dynasty: '唐', text: '空山不见人，但闻人语响。返景入深林，复照青苔上。' },
  { type: 'poem', title: '竹里馆', author: '王维', dynasty: '唐', text: '独坐幽篁里，弹琴复长啸。深林人不知，明月来相照。' },
  { type: 'poem', title: '鸟鸣涧', author: '王维', dynasty: '唐', text: '人闲桂花落，夜静春山空。月出惊山鸟，时鸣春涧中。' },
  { type: 'poem', title: '送元二使安西', author: '王维', dynasty: '唐', text: '渭城朝雨浥轻尘，客舍青青柳色新。劝君更尽一杯酒，西出阳关无故人。' },
  { type: 'poem', title: '九月九日忆山东兄弟', author: '王维', dynasty: '唐', text: '独在异乡为异客，每逢佳节倍思亲。遥知兄弟登高处，遍插茱萸少一人。' },
  { type: 'poem', title: '山居秋暝', author: '王维', dynasty: '唐', text: '空山新雨后，天气晚来秋。明月松间照，清泉石上流。竹喧归浣女，莲动下渔舟。随意春芳歇，王孙自可留。' },
  { type: 'poem', title: '江雪', author: '柳宗元', dynasty: '唐', text: '千山鸟飞绝，万径人踪灭。孤舟蓑笠翁，独钓寒江雪。' },
  { type: 'poem', title: '寻隐者不遇', author: '贾岛', dynasty: '唐', text: '松下问童子，言师采药去。只在此山中，云深不知处。' },
  { type: 'poem', title: '悯农·其二', author: '李绅', dynasty: '唐', text: '锄禾日当午，汗滴禾下土。谁知盘中餐，粒粒皆辛苦。' },
  { type: 'poem', title: '登乐游原', author: '李商隐', dynasty: '唐', text: '向晚意不适，驱车登古原。夕阳无限好，只是近黄昏。' },
  { type: 'poem', title: '夜雨寄北', author: '李商隐', dynasty: '唐', text: '君问归期未有期，巴山夜雨涨秋池。何当共剪西窗烛，却话巴山夜雨时。' },
  { type: 'poem', title: '山行', author: '杜牧', dynasty: '唐', text: '远上寒山石径斜，白云生处有人家。停车坐爱枫林晚，霜叶红于二月花。' },
  { type: 'poem', title: '清明', author: '杜牧', dynasty: '唐', text: '清明时节雨纷纷，路上行人欲断魂。借问酒家何处有，牧童遥指杏花村。' },
  { type: 'poem', title: '江南春', author: '杜牧', dynasty: '唐', text: '千里莺啼绿映红，水村山郭酒旗风。南朝四百八十寺，多少楼台烟雨中。' },
  { type: 'poem', title: '泊秦淮', author: '杜牧', dynasty: '唐', text: '烟笼寒水月笼沙，夜泊秦淮近酒家。商女不知亡国恨，隔江犹唱后庭花。' },
  // ---------- 唐诗（二）----------
  { type: 'poem', title: '望庐山瀑布', author: '李白', dynasty: '唐', text: '日照香炉生紫烟，遥看瀑布挂前川。飞流直下三千尺，疑是银河落九天。' },
  { type: 'poem', title: '早发白帝城', author: '李白', dynasty: '唐', text: '朝辞白帝彩云间，千里江陵一日还。两岸猿声啼不住，轻舟已过万重山。' },
  { type: 'poem', title: '黄鹤楼送孟浩然之广陵', author: '李白', dynasty: '唐', text: '故人西辞黄鹤楼，烟花三月下扬州。孤帆远影碧空尽，唯见长江天际流。' },
  { type: 'poem', title: '赠汪伦', author: '李白', dynasty: '唐', text: '李白乘舟将欲行，忽闻岸上踏歌声。桃花潭水深千尺，不及汪伦送我情。' },
  { type: 'poem', title: '望天门山', author: '李白', dynasty: '唐', text: '天门中断楚江开，碧水东流至此回。两岸青山相对出，孤帆一片日边来。' },
  { type: 'poem', title: '将进酒', author: '李白', dynasty: '唐', text: '君不见黄河之水天上来，奔流到海不复回。君不见高堂明镜悲白发，朝如青丝暮成雪。人生得意须尽欢，莫使金樽空对月。天生我材必有用，千金散尽还复来。烹羊宰牛且为乐，会须一饮三百杯。岑夫子，丹丘生，将进酒，杯莫停。与君歌一曲，请君为我倾耳听。钟鼓馔玉不足贵，但愿长醉不愿醒。古来圣贤皆寂寞，惟有饮者留其名。主人何为言少钱，径须沽取对君酌。五花马，千金裘，呼儿将出换美酒，与尔同销万古愁。' },
  { type: 'poem', title: '绝句', author: '杜甫', dynasty: '唐', text: '两个黄鹂鸣翠柳，一行白鹭上青天。窗含西岭千秋雪，门泊东吴万里船。' },
  { type: 'poem', title: '春夜喜雨', author: '杜甫', dynasty: '唐', text: '好雨知时节，当春乃发生。随风潜入夜，润物细无声。野径云俱黑，江船火独明。晓看红湿处，花重锦官城。' },
  { type: 'poem', title: '望岳', author: '杜甫', dynasty: '唐', text: '岱宗夫如何？齐鲁青未了。造化钟神秀，阴阳割昏晓。荡胸生曾云，决眦入归鸟。会当凌绝顶，一览众山小。' },
  { type: 'poem', title: '江畔独步寻花·其六', author: '杜甫', dynasty: '唐', text: '黄四娘家花满蹊，千朵万朵压枝低。留连戏蝶时时舞，自在娇莺恰恰啼。' },
  // ---------- 唐诗（三）----------
  { type: 'poem', title: '出塞', author: '王昌龄', dynasty: '唐', text: '秦时明月汉时关，万里长征人未还。但使龙城飞将在，不教胡马度阴山。' },
  { type: 'poem', title: '芙蓉楼送辛渐', author: '王昌龄', dynasty: '唐', text: '寒雨连江夜入吴，平明送客楚山孤。洛阳亲友如相问，一片冰心在玉壶。' },
  { type: 'poem', title: '凉州词', author: '王之涣', dynasty: '唐', text: '黄河远上白云间，一片孤城万仞山。羌笛何须怨杨柳，春风不度玉门关。' },
  { type: 'poem', title: '游子吟', author: '孟郊', dynasty: '唐', text: '慈母手中线，游子身上衣。临行密密缝，意恐迟迟归。谁言寸草心，报得三春晖。' },
  { type: 'poem', title: '宿建德江', author: '孟浩然', dynasty: '唐', text: '移舟泊烟渚，日暮客愁新。野旷天低树，江清月近人。' },
  { type: 'poem', title: '过故人庄', author: '孟浩然', dynasty: '唐', text: '故人具鸡黍，邀我至田家。绿树村边合，青山郭外斜。开轩面场圃，把酒话桑麻。待到重阳日，还来就菊花。' },
  { type: 'poem', title: '赋得古原草送别', author: '白居易', dynasty: '唐', text: '离离原上草，一岁一枯荣。野火烧不尽，春风吹又生。远芳侵古道，晴翠接荒城。又送王孙去，萋萋满别情。' },
  { type: 'poem', title: '钱塘湖春行', author: '白居易', dynasty: '唐', text: '孤山寺北贾亭西，水面初平云脚低。几处早莺争暖树，谁家新燕啄春泥。乱花渐欲迷人眼，浅草才能没马蹄。最爱湖东行不足，绿杨阴里白沙堤。' },
  { type: 'poem', title: '乌衣巷', author: '刘禹锡', dynasty: '唐', text: '朱雀桥边野草花，乌衣巷口夕阳斜。旧时王谢堂前燕，飞入寻常百姓家。' },
  { type: 'poem', title: '秋词', author: '刘禹锡', dynasty: '唐', text: '自古逢秋悲寂寥，我言秋日胜春朝。晴空一鹤排云上，便引诗情到碧霄。' },
  { type: 'poem', title: '陋室铭', author: '刘禹锡', dynasty: '唐', text: '山不在高，有仙则名。水不在深，有龙则灵。斯是陋室，惟吾德馨。苔痕上阶绿，草色入帘青。谈笑有鸿儒，往来无白丁。可以调素琴，阅金经。无丝竹之乱耳，无案牍之劳形。南阳诸葛庐，西蜀子云亭。孔子云：何陋之有？' },
  { type: 'poem', title: '题都城南庄', author: '崔护', dynasty: '唐', text: '去年今日此门中，人面桃花相映红。人面不知何处去，桃花依旧笑春风。' },
  { type: 'poem', title: '滁州西涧', author: '韦应物', dynasty: '唐', text: '独怜幽草涧边生，上有黄鹂深树鸣。春潮带雨晚来急，野渡无人舟自横。' },
  { type: 'poem', title: '枫桥夜泊', author: '张继', dynasty: '唐', text: '月落乌啼霜满天，江枫渔火对愁眠。姑苏城外寒山寺，夜半钟声到客船。' },
  // ---------- 宋诗宋词 ----------
  { type: 'poem', title: '元日', author: '王安石', dynasty: '宋', text: '爆竹声中一岁除，春风送暖入屠苏。千门万户曈曈日，总把新桃换旧符。' },
  { type: 'poem', title: '梅花', author: '王安石', dynasty: '宋', text: '墙角数枝梅，凌寒独自开。遥知不是雪，为有暗香来。' },
  { type: 'poem', title: '泊船瓜洲', author: '王安石', dynasty: '宋', text: '京口瓜洲一水间，钟山只隔数重山。春风又绿江南岸，明月何时照我还。' },
  { type: 'poem', title: '饮湖上初晴后雨', author: '苏轼', dynasty: '宋', text: '水光潋滟晴方好，山色空蒙雨亦奇。欲把西湖比西子，淡妆浓抹总相宜。' },
  { type: 'poem', title: '题西林壁', author: '苏轼', dynasty: '宋', text: '横看成岭侧成峰，远近高低各不同。不识庐山真面目，只缘身在此山中。' },
  { type: 'poem', title: '惠崇春江晚景', author: '苏轼', dynasty: '宋', text: '竹外桃花三两枝，春江水暖鸭先知。蒌蒿满地芦芽短，正是河豚欲上时。' },
  { type: 'poem', title: '水调歌头·明月几时有', author: '苏轼', dynasty: '宋', text: '明月几时有？把酒问青天。不知天上宫阙，今夕是何年。我欲乘风归去，又恐琼楼玉宇，高处不胜寒。起舞弄清影，何似在人间。转朱阁，低绮户，照无眠。不应有恨，何事长向别时圆？人有悲欢离合，月有阴晴圆缺，此事古难全。但愿人长久，千里共婵娟。' },
  { type: 'poem', title: '念奴娇·赤壁怀古', author: '苏轼', dynasty: '宋', text: '大江东去，浪淘尽，千古风流人物。故垒西边，人道是，三国周郎赤壁。乱石穿空，惊涛拍岸，卷起千堆雪。江山如画，一时多少豪杰。遥想公瑾当年，小乔初嫁了，雄姿英发。羽扇纶巾，谈笑间，樯橹灰飞烟灭。故国神游，多情应笑我，早生华发。人生如梦，一尊还酹江月。' },
  { type: 'poem', title: '如梦令·昨夜雨疏风骤', author: '李清照', dynasty: '宋', text: '昨夜雨疏风骤，浓睡不消残酒。试问卷帘人，却道海棠依旧。知否，知否？应是绿肥红瘦。' },
  { type: 'poem', title: '夏日绝句', author: '李清照', dynasty: '宋', text: '生当作人杰，死亦为鬼雄。至今思项羽，不肯过江东。' },
  { type: 'poem', title: '满江红·怒发冲冠', author: '岳飞', dynasty: '宋', text: '怒发冲冠，凭栏处、潇潇雨歇。抬望眼，仰天长啸，壮怀激烈。三十功名尘与土，八千里路云和月。莫等闲、白了少年头，空悲切。靖康耻，犹未雪；臣子恨，何时灭？驾长车，踏破贺兰山缺。壮志饥餐胡虏肉，笑谈渴饮匈奴血。待从头、收拾旧山河，朝天阙。' },
  { type: 'poem', title: '青玉案·元夕', author: '辛弃疾', dynasty: '宋', text: '东风夜放花千树。更吹落、星如雨。宝马雕车香满路。凤箫声动，玉壶光转，一夜鱼龙舞。蛾儿雪柳黄金缕，笑语盈盈暗香去。众里寻他千百度。蓦然回首，那人却在，灯火阑珊处。' },
  { type: 'poem', title: '西江月·夜行黄沙道中', author: '辛弃疾', dynasty: '宋', text: '明月别枝惊鹊，清风半夜鸣蝉。稻花香里说丰年，听取蛙声一片。七八个星天外，两三点雨山前。旧时茅店社林边，路转溪桥忽见。' },
  { type: 'poem', title: '卜算子·咏梅', author: '陆游', dynasty: '宋', text: '驿外断桥边，寂寞开无主。已是黄昏独自愁，更著风和雨。无意苦争春，一任群芳妒。零落成泥碾作尘，只有香如故。' },
  { type: 'poem', title: '游山西村', author: '陆游', dynasty: '宋', text: '莫笑农家腊酒浑，丰年留客足鸡豚。山重水复疑无路，柳暗花明又一村。箫鼓追随春社近，衣冠简朴古风存。从今若许闲乘月，拄杖无时夜叩门。' },
  { type: 'poem', title: '观书有感', author: '朱熹', dynasty: '宋', text: '半亩方塘一鉴开，天光云影共徘徊。问渠那得清如许？为有源头活水来。' },
  { type: 'poem', title: '小池', author: '杨万里', dynasty: '宋', text: '泉眼无声惜细流，树阴照水爱晴柔。小荷才露尖尖角，早有蜻蜓立上头。' },
  { type: 'poem', title: '晓出净慈寺送林子方', author: '杨万里', dynasty: '宋', text: '毕竟西湖六月中，风光不与四时同。接天莲叶无穷碧，映日荷花别样红。' },
  { type: 'poem', title: '爱莲说', author: '周敦颐', dynasty: '宋', text: '水陆草木之花，可爱者甚蕃。晋陶渊明独爱菊。自李唐来，世人甚爱牡丹。予独爱莲之出淤泥而不染，濯清涟而不妖，中通外直，不蔓不枝，香远益清，亭亭净植，可远观而不可亵玩焉。予谓菊，花之隐逸者也；牡丹，花之富贵者也；莲，花之君子者也。' },
  // ---------- 元明清 & 汉魏晋南北朝 ----------
  { type: 'poem', title: '天净沙·秋思', author: '马致远', dynasty: '元', text: '枯藤老树昏鸦，小桥流水人家，古道西风瘦马。夕阳西下，断肠人在天涯。' },
  { type: 'poem', title: '山坡羊·潼关怀古', author: '张养浩', dynasty: '元', text: '峰峦如聚，波涛如怒，山河表里潼关路。望西都，意踌躇。伤心秦汉经行处，宫阙万间都做了土。兴，百姓苦；亡，百姓苦。' },
  { type: 'poem', title: '竹石', author: '郑燮', dynasty: '清', text: '咬定青山不放松，立根原在破岩中。千磨万击还坚劲，任尔东西南北风。' },
  { type: 'poem', title: '己亥杂诗', author: '龚自珍', dynasty: '清', text: '浩荡离愁白日斜，吟鞭东指即天涯。落红不是无情物，化作春泥更护花。' },
  { type: 'poem', title: '观沧海', author: '曹操', dynasty: '汉', text: '东临碣石，以观沧海。水何澹澹，山岛竦峙。树木丛生，百草丰茂。秋风萧瑟，洪波涌起。日月之行，若出其中；星汉灿烂，若出其里。幸甚至哉，歌以咏志。' },
  { type: 'poem', title: '饮酒·其五', author: '陶渊明', dynasty: '晋', text: '结庐在人境，而无车马喧。问君何能尔？心远地自偏。采菊东篱下，悠然见南山。山气日夕佳，飞鸟相与还。此中有真意，欲辨已忘言。' },
  { type: 'poem', title: '长歌行', author: '佚名', dynasty: '汉', text: '青青园中葵，朝露待日晞。阳春布德泽，万物生光辉。常恐秋节至，焜黄华叶衰。百川东到海，何时复西归？少壮不努力，老大徒伤悲。' },
  { type: 'poem', title: '敕勒歌', author: '佚名', dynasty: '北朝', text: '敕勒川，阴山下。天似穹庐，笼盖四野。天苍苍，野茫茫，风吹草低见牛羊。' },

  // ---------- 中国古典格言（10 条）----------
  { type: 'quote', author: '孔子', from: '《论语·为政》', text: '学而不思则罔，思而不学则殆。' },
  { type: 'quote', author: '孔子', from: '《论语·述而》', text: '三人行，必有我师焉。择其善者而从之，其不善者而改之。' },
  { type: 'quote', author: '老子', from: '《道德经》', text: '千里之行，始于足下。' },
  { type: 'quote', author: '老子', from: '《道德经》', text: '上善若水。水善利万物而不争，处众人之所恶，故几于道。' },
  { type: 'quote', author: '孟子', from: '《孟子·告子下》', text: '天将降大任于是人也，必先苦其心志，劳其筋骨，饿其体肤，空乏其身，行拂乱其所为。' },
  { type: 'quote', author: '庄子', from: '《庄子·养生主》', text: '吾生也有涯，而知也无涯。' },
  { type: 'quote', author: '荀子', from: '《荀子·劝学》', text: '不积跬步，无以至千里；不积小流，无以成江海。' },
  { type: 'quote', author: '佚名', from: '《周易·乾卦》', text: '天行健，君子以自强不息；地势坤，君子以厚德载物。' },
  { type: 'quote', author: '诸葛亮', from: '《诫子书》', text: '非淡泊无以明志，非宁静无以致远。' },
  { type: 'quote', author: '洪应明', from: '《菜根谭》', text: '宠辱不惊，闲看庭前花开花落；去留无意，漫随天外云卷云舒。' },

  // ---------- 外国名言（20 条）----------
  { type: 'quote', author: '莎士比亚', origin: '英', from: '《哈姆雷特》', text: '简洁是智慧的灵魂，冗长是肤浅的藻饰。' },
  { type: 'quote', author: '培根', origin: '英', from: '《论读书》', text: '读史使人明智，读诗使人灵秀，数学使人周密，科学使人深刻，伦理学使人庄重，逻辑修辞之学使人善辩。' },
  { type: 'quote', author: '歌德', origin: '德', from: '《浮士德》', text: '理论是灰色的，而生命之树常青。' },
  { type: 'quote', author: '雨果', origin: '法', from: '《悲惨世界》', text: '世界上最宽阔的是海洋，比海洋更宽阔的是天空，比天空更宽阔的是人的胸怀。' },
  { type: 'quote', author: '托尔斯泰', origin: '俄', from: '《安娜·卡列尼娜》', text: '幸福的家庭都是相似的，不幸的家庭各有各的不幸。' },
  { type: 'quote', author: '泰戈尔', origin: '印', from: '《飞鸟集》', text: '让生如夏花之绚烂，死如秋叶之静美。' },
  { type: 'quote', author: '泰戈尔', origin: '印', from: '《飞鸟集》', text: '如果你因失去了太阳而流泪，那么你也将失去群星了。' },
  { type: 'quote', author: '尼采', origin: '德', from: '《偶像的黄昏》', text: '每一个不曾起舞的日子，都是对生命的辜负。' },
  { type: 'quote', author: '尼采', origin: '德', from: '《偶像的黄昏》', text: '那些杀不死我的，必使我更强大。' },
  { type: 'quote', author: '叔本华', origin: '德', from: '《人生的智慧》', text: '人生如同钟摆，在痛苦与无聊之间来回摆动。' },
  { type: 'quote', author: '罗曼·罗兰', origin: '法', from: '《米开朗琪罗传》', text: '世界上只有一种真正的英雄主义，那就是在认清生活的真相之后依然热爱生活。' },
  { type: 'quote', author: '爱默生', origin: '美', from: '《论自助》', text: '自信是成功的第一秘诀。' },
  { type: 'quote', author: '梭罗', origin: '美', from: '《瓦尔登湖》', text: '我步入丛林，因为我希望生活得有意义，我希望活得深刻，吸取生命中所有的精华。' },
  { type: 'quote', author: '居里夫人', origin: '波兰', from: '演讲', text: '生活中没有什么可怕的东西，只有需要理解的东西。' },
  { type: 'quote', author: '爱因斯坦', origin: '德', from: '访谈', text: '想象力比知识更重要，因为知识是有限的，而想象力概括着世界的一切。' },
  { type: 'quote', author: '帕斯卡尔', origin: '法', from: '《思想录》', text: '人只不过是一根苇草，是自然界最脆弱的东西，但他是一根能思想的苇草。' },
  { type: 'quote', author: '塞涅卡', origin: '古罗马', from: '《论生命之短暂》', text: '人生如同故事，重要的不在于有多长，而在于有多精彩。' },
  { type: 'quote', author: '贝多芬', origin: '德', from: '书信', text: '我要扼住命运的咽喉，它决不能使我完全屈服。' },
  { type: 'quote', author: '牛顿', origin: '英', from: '书信', text: '如果说我看得比别人更远些，那是因为我站在巨人的肩膀上。' },
  { type: 'quote', author: '马可·奥勒留', origin: '古罗马', from: '《沉思录》', text: '你所拥有的只有当下这一刻，你所失去的也只有当下这一刻。' }
]

/* 去空白后计字：换行/空格不计入字数（长诗的排版换行不影响 300 字口径） */
function countChars(text) {
  return String(text == null ? '' : text).replace(/\s+/g, '').length
}

/* 卡片预览：超长才截断，截断处补省略号；短文本原样返回（多余标点不补） */
function excerpt(text, len) {
  const n = len || PREVIEW_LEN
  const s = String(text == null ? '' : text).replace(/\s+/g, '')
  return s.length > n ? s.slice(0, n) + '…' : s
}

/* 本地日期 → 纪元以来的天数（用本地年月日构造 UTC 毫秒，保证跨天在本地 0 点翻页） */
function dayNumber(date) {
  const d = date instanceof Date ? date : new Date()
  return Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - EPOCH) / DAY_MS)
}

/* 确定性取模：同一天恒定，相邻两天相差 1（负数日期也能回落到合法下标）。
   total 参数用「显式判空」而不是 `total || 长度`：传 0 时 || 会静默换成池子长度，
   除零保护形同虚设（2026-09-18 被测试咬出来的坑） */
function pickIndex(date, total) {
  const n = (total === undefined || total === null) ? QUOTES.length : Number(total)
  if (!isFinite(n) || n < 1) return 0
  return ((dayNumber(date) % n) + n) % n
}

/* 越界下标统一回落到今天的下标；非数字/NaN 同样回落（wxml 传参与手写 URL 都不可信）。
   注意 '' / null / undefined 必须显式挡掉：Number('') === 0，不挡会静默跳到第 1 条 */
function safeIndex(index, date) {
  // 只认数字与「纯数字字符串」；空串 / 纯空白 / 数组 / 对象 / 布尔 一律回落今天
  const raw = typeof index === 'string' ? index.trim() : index
  if (raw === '' || raw === null || raw === undefined ||
      typeof raw === 'boolean' || typeof raw === 'object' || typeof raw === 'function') {
    return pickIndex(date)
  }
  const i = Number(raw)
  if (!isFinite(i) || Math.floor(i) !== i || i < 0 || i >= QUOTES.length) {
    return pickIndex(date)
  }
  return i
}

/* 卡片视图模型：line1 = 诗词名 / 作者，line2 = 正文前 16 字 */
function toCard(index, date) {
  const i = safeIndex(index, date)
  const item = QUOTES[i]
  return {
    index: i,
    type: item.type,
    icon: ICON,
    line1: item.type === 'poem' ? item.title : item.author,
    line2: excerpt(item.text)
  }
}

/* 今日一签（侧栏卡片用）：下标 + 卡片两行 */
function getToday(date) {
  return toCard(pickIndex(date), date)
}

/* 全篇视图模型：标题 / 副题 / 正文 / 复制文本 */
function getDetail(index, date) {
  const i = safeIndex(index, date)
  const item = QUOTES[i]
  const isPoem = item.type === 'poem'
  const head = isPoem ? item.title : item.author
  const parts = []
  if (isPoem) {
    if (item.dynasty) parts.push(item.dynasty)
    if (item.author) parts.push(item.author)
  } else {
    if (item.origin) parts.push(item.origin)
    if (item.from) parts.push(item.from)
  }
  const byline = parts.join(' · ')
  return {
    index: i,
    isPoem: isPoem,
    kind: isPoem ? '诗词' : '名言',
    head: head,
    byline: byline,
    body: String(item.text || ''),
    // 复制全文：标题 · 副题（换行）正文 —— 粘到别处自带出处
    copyText: head + (byline ? ' · ' + byline : '') + '\n\n' + String(item.text || '')
  }
}

module.exports = {
  MAX_LEN,
  PREVIEW_LEN,
  ICON,
  QUOTES,
  countChars,
  excerpt,
  dayNumber,
  pickIndex,
  safeIndex,
  toCard,
  getToday,
  getDetail
}
