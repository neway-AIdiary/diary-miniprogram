"""第二步：用 Python 标准库 zipfile 验证 docx 合法性（模拟 Word/WPS 的解析）"""
import sys, zipfile

z = zipfile.ZipFile('test.docx')
names = z.namelist()
print('文件清单:', names)
required = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/_rels/document.xml.rels']
for n in required:
    assert n in names, '缺少 ' + n
assert 'word/media/image1.png' in names, '缺少内嵌图片'

bad = z.testzip()  # 逐条 CRC 校验
assert bad is None, 'CRC 校验失败: ' + str(bad)
print('CRC 校验: OK')

# 图片逐字节一致
img = z.read('word/media/image1.png')
origin = open('tmp_img.png', 'rb').read()
assert img == origin, '内嵌图片与原始文件不一致'
print('内嵌图片: OK（%d 字节，逐字节一致）' % len(img))

# document.xml 可解析、含关键结构
xml = z.read('word/document.xml').decode('utf-8')
open('doc.xml', 'w', encoding='utf-8').write(xml)
import xml.dom.minidom as md
md.parseString(xml)  # XML 合法性
assert '<w:hyperlink r:id="rIdV1"' in xml, '缺少视频超链接'
assert xml.count('AIDIARY:') == 2, '隐藏数据段数量不对'
assert '点击查看视频' in xml and '大学同学' in xml and '腾讯滨海大厦' in xml
print('document.xml: XML 合法、超链接/隐藏数据/正文齐全')
print('\n全部通过：标准 zip + OOXML 结构，Word/WPS/微信可正常打开')
