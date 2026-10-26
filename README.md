# Slop Kahramanmaraş (SLOPMARAS)

[three.js](https://threejs.org/), WebGPURenderer ve TSL ile yapılmış bir Kahramanmaraş şehir simülasyonu. Şehir merkezini (Atatürk Meydanı, Kale ve Ulu Camii, çarşılar, Trabzon Caddesi, Kıbrıs Meydanı, Yenişehir, Bahçelievler, Dulkadiroğlu ve gar çevresi) yürüyerek, taksiyle, bisikletle ya da helikopterle gez.

Haritayı OpenStreetMap'ten üretiyor: 40.000'den fazla bina, gerçek yol ağı üzerinde trafik, parklar ve çınar ağaçları. Sarı taksiler 46 plakalı, trafik sağdan akıyor. Konum menüsünden Atatürk Meydanı, Kahramanmaraş Kalesi, Ulu Camii, Taş Medrese, Kıbrıs Meydanı, Dondurma Müzesi, Sütçü İmam Anıtı, Kurtuluş Müzesi, Büyükşehir Belediyesi, Millî İrade Meydanı, Piazza AVM, Gar, Millet Bahçesi ve Dulkadiroğlu Parkı'na ışınlanabilirsin.

Navigasyon (`G`) aynı yol ağı üzerinde şerit şerit rota çizer; ister kendin sür, ister taksiyi otomatik pilota (Self-driving ya da Crazy Taxi) bırak. `T` ile şoför koltuğuna geçersin.

Proje, mrdoob'un [Slop New York](https://github.com/mrdoob/slop-newyork) projesinden türeyen zz85'in [Slop Singapore](https://github.com/zz85/slop-singapore) uyarlaması üzerine kuruldu. Diğer şehirler de hâlâ çalışıyor: `?city=singapore` ve `?city=nyc`.

## Çalıştırma

Klasörü bir web sunucusuyla sun ve WebGPU (ya da WebGL 2) destekleyen bir tarayıcıda aç:

```sh
python -m http.server 8000 --bind 127.0.0.1    # sonra http://127.0.0.1:8000/ adresini aç
```

### Ev ağında (Wi-Fi) paylaşma

Windows'ta `serve-lan.bat` dosyasına çift tıkla (ya da `python serve-lan.py`). Aynı ağdaki telefon ve bilgisayarlar için adresleri listeler:

- `https://<bilgisayarın-IP'si>:8446/`: WebGPU ile hızlı. Sertifika kendinden imzalı olduğu için tarayıcı bir kez uyarı gösterir, "Yine de devam et" demen yeterli.
- `http://<bilgisayarın-IP'si>:8046/`: uyarısız ama WebGL 2 ile daha yavaş (tarayıcılar WebGPU'yu yalnızca HTTPS ve localhost'ta açıyor).

Diğer cihazlar bağlanamazsa Windows Güvenlik Duvarı'nda Python'a "Özel ağlar" için izin ver.

## Şehri değiştirme

Kahramanmaraş'ın tanımı `tools/city/cities/kahramanmaras.mjs` dosyasında: harita sınırları, merkez noktası, semtlerin bina tipleri, ışınlanma noktaları, araç renkleri ve plakalar, harita etiketleri. Değiştirdikten sonra:

```sh
node tools/city/fetch.mjs kahramanmaras --force                       # OpenStreetMap katmanlarını Overpass'tan indirir
node --max-old-space-size=8192 tools/city/build.mjs kahramanmaras     # js/kahramanmaras-geodata.js dosyasını yazar
node tools/city/preview.mjs kahramanmaras preview.png                 # sonucu kontrol etmek için bir harita resmi
```

Ağaçlar OpenStreetMap'teki ağaçlardan, ağaç sıralarından ve parklara serpiştirilen çınarlardan oluşur (`trees.source: 'osm'`).

Başka bir şehir eklemek için `tools/city/cities/<şehir>.mjs` dosyası yaz, aynı komutları o şehir için çalıştır ve sayfayı `?city=<şehir>` ile aç.

Diğer şehirler ve uyarlamalar için: [Slop Cities](https://github.com/zz85/slop-cities).

## Lisans ve veri

Kod [MIT Lisansı](LICENSE) ile sunuluyor.

Coğrafi veri: © [OpenStreetMap katkıcıları](https://www.openstreetmap.org/copyright) (ODbL); New York'unki ayrıca NYC Open Data. Singapur'un ağaçları: [Trees.sg](https://www.nparks.gov.sg/treessg) © National Parks Board, [cheeaun/sgtreesdata](https://github.com/cheeaun/sgtreesdata) üzerinden. Üçüncü taraf veri ve bağımlılıklar kendi lisanslarını korur.
