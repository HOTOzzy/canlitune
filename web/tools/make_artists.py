# Generates web/artists.json. Each artist = style archetype + small overrides.
# Song entries: "Title|Key|BPM" (key/BPM from general knowledge, NOT verified) or just "Title".
import json, re
BASE = dict(retuneMs=30, humanize=15, flex=20, vibrato=0, scale="major", formant=0, mode=1, transpose=0, v2Level=0, v2Interval=0, v2Detune=0, mix=1,
            hpfHz=90, gateDb=-52, compThr=-20, compRatio=3, compAtk=8, compRel=100, compMakeup=3, satDrive=0, satMix=0,
            bpm=110, dlyDiv=1, dlyFb=0.2, dlyMix=0.08, dlyDamp=0.5, revTime=1.5, revDamp=0.5, revPre=20, revMix=0.18,
            bodyDb=0, presDb=0, airDb=0, lpfHz=20000)
STYLES = {
 "hard":   ("Sert efekt (retune 0)", dict(presDb=3, airDb=3, hpfHz=120, retuneMs=0, humanize=0, flex=0, mode=0, scale="minor", compRatio=4, dlyMix=0.12, revMix=0.2)),
 "trap":   ("Trap (hızlı retune)", dict(airDb=3, presDb=1, retuneMs=10, humanize=0, flex=0, mode=0, scale="minor", hpfHz=110, compThr=-22, compRatio=4, satDrive=4, satMix=0.2, bpm=140, dlyMix=0.15, revTime=1.8, revDamp=0.6, revMix=0.2)),
 "trapdark": ("Karanlık trap (sert + uzun reverb)", dict(airDb=-2, bodyDb=2, lpfHz=11000, retuneMs=4, humanize=0, flex=0, mode=0, scale="minor", hpfHz=110, compThr=-22, compRatio=4, satDrive=5, satMix=0.25, bpm=140, dlyMix=0.2, dlyDamp=0.6, revTime=2.6, revDamp=0.8, revPre=30, revMix=0.28)),
 "rage":   ("Rage / hyper-trap (sert + doygun)", dict(presDb=4, lpfHz=9500, retuneMs=2, humanize=0, flex=0, mode=0, scale="minor", hpfHz=130, compThr=-24, compRatio=5, compAtk=3, satDrive=10, satMix=0.4, bpm=150, dlyDiv=0.5, dlyMix=0.1, revTime=1.8, revMix=0.3)),
 "melodic":("Melodik rap (orta retune)", dict(airDb=2, bodyDb=1, retuneMs=18, humanize=5, flex=0, mode=0, scale="minor", compRatio=3.5, satDrive=3, satMix=0.15, bpm=130, dlyMix=0.14, revTime=1.8, revMix=0.2)),
 "pop":    ("Pop (şeffaf düzeltme)", dict(airDb=3, presDb=1)),
 "poptune":("Pop (duyulur düzeltme)", dict(airDb=5, presDb=2, hpfHz=115, retuneMs=12, humanize=5, flex=0, mode=0, v2Level=0.12, v2Detune=8, bpm=120, dlyDiv=0.5, dlyMix=0.1, revMix=0.2)),
 "hyper":  ("Hyperpop (sert + formant)", dict(airDb=6, presDb=3, hpfHz=140, retuneMs=0, humanize=0, flex=0, mode=1, formant=2, compRatio=5, satDrive=8, satMix=0.35, bpm=150, dlyDiv=0.5, dlyMix=0.12, revMix=0.25)),
 "rnb":    ("R&B (yumuşak, formant koruma)", dict(bodyDb=2, airDb=3, retuneMs=35, humanize=25, flex=25, scale="minor", bpm=90, dlyDiv=0.5, dlyMix=0.08, revTime=1.7, revPre=30, revMix=0.25)),
 "rnbtune":("Trap-soul (duyulur R&B tune)", dict(bodyDb=2, airDb=-1, lpfHz=12000, retuneMs=14, humanize=8, flex=0, mode=0, scale="minor", bpm=85, dlyMix=0.14, dlyDamp=0.6, revTime=2.2, revDamp=0.7, revPre=30, revMix=0.3)),
 "soul":   ("Soul (neredeyse düzeltmesiz)", dict(bodyDb=1, presDb=2, retuneMs=70, humanize=45, flex=45, compRatio=2.5, bpm=90, dlyMix=0, revTime=1.3, revMix=0.14)),
 "afro":   ("Afrobeats (parlak, orta retune)", dict(airDb=4, bodyDb=1, retuneMs=15, humanize=5, flex=0, mode=0, bpm=105, dlyDiv=0.75, dlyMix=0.14, revTime=1.5, revMix=0.2)),
 "latin":  ("Reggaeton / latin trap", dict(bodyDb=3, presDb=2, retuneMs=10, humanize=0, flex=0, mode=0, scale="minor", compRatio=4, bpm=95, dlyMix=0.14, revTime=1.7, revMix=0.22)),
 "kpop":   ("K-pop (parlak, çiftlenmiş)", dict(airDb=5, presDb=2, hpfHz=120, retuneMs=22, humanize=10, flex=10, v2Level=0.15, v2Detune=8, compRatio=3.5, bpm=120, dlyDiv=0.5, dlyMix=0.08, revMix=0.18)),
 "dance":  ("Dance / house (sert + çift ses)", dict(airDb=4, presDb=3, hpfHz=130, retuneMs=5, humanize=0, flex=0, mode=0, v2Level=0.2, v2Detune=10, compRatio=4, bpm=124, dlyDiv=0.75, dlyMix=0.15, revTime=1.8, revMix=0.25)),
 "prism":  ("Harmonizer (sert tune + armoni sesi)", dict(airDb=2, bodyDb=2, retuneMs=0, humanize=0, flex=0, mode=0, v2Level=0.6, v2Interval=-5, bpm=80, dlyMix=0, revTime=2.4, revMix=0.3)),
 "arabesk":("Türk / arabesk (yavaş, kromatik)", dict(bodyDb=2, presDb=2, retuneMs=90, humanize=50, flex=50, scale="chromatic", bpm=90, dlyMix=0.06, revTime=1.8, revMix=0.22)),
}
A = []
def a(name, genre, style, songs, note="", **ov): A.append(dict(name=name, g=genre, s=style, o=ov, note=note, songs=songs.split(";")))

# ---------- rap / trap ----------
a("Drake","rap","melodic","Hotline Bling|Dm|135;One Dance|A#m|104;God's Plan;Passionfruit;Hold On, We're Going Home;In My Feelings","40 altyapının tizlerini kısar ki vokal üstte tek başına parlasın: bu yüzden vokal parlak ve önde, beat boğuk.", src="drake")
a("Lil Wayne","rap","hard","Lollipop;How to Love;A Milli;Mirror;Love Me","2008 dönemi: sert, kırık vokal efekti.", satDrive=5, satMix=0.2)
a("Young Thug","trap","trap","Best Friend;Hot;The London;Check;Go Crazy","Auto-Tune kaymaları basamak basamak kırar ve titremeyi öne çıkarır: çok hızlı retune + vibrato.", scale="chromatic", src="thug")
a("Gunna","trap","trap","Drip Too Hard;Pushin P;fukumean;Top Off;Skybox","Düz, akıcı melodik akış.", retuneMs=12)
a("Lil Baby","trap","trap","Drip Too Hard;Yes Indeed;Woah;The Bigger Picture;Freestyle","Rap ağırlıklı; efekt cümle sonlarında duyulur.", retuneMs=15)
a("Quavo / Migos","trap","trap","Bad and Boujee;Stir Fry;Walk It Talk It;MotorSport;T-Shirt","Nakaratlarda sert tune + ad-lib.", retuneMs=6, v2Level=0.15, v2Detune=10)
a("21 Savage","trap","melodic","a lot;Bank Account;Rockstar;Runnin;redrum","Alçak, sakin ton; hafif düzeltme.", retuneMs=25, hpfHz=80)
a("Juice WRLD","rap","melodic","Lucid Dreams|F#m|84;All Girls Are the Same;Robbery;Wishing Well;Legends","Emo-rap: duygusal, orta hız.", retuneMs=16, revMix=0.24)
a("XXXTentacion","rap","melodic","SAD!;Jocelyn Flores;changes;Moonlight;Fuck Love","Lo-fi, yakın mikrofon.", retuneMs=28, satDrive=6, satMix=0.25, revMix=0.15)
a("Lil Nas X","rap","poptune","Old Town Road;MONTERO (Call Me by Your Name);INDUSTRY BABY;THATS WHAT I WANT;Panini","Zincirde Auto-Tune EFX ve sert limiter (SOS).", compRatio=6, compThr=-24, src="lilnasx")
a("Roddy Ricch","trap","trap","The Box;High Fashion;Ballin';Down Below;Die Young","Melodik, vibratolu nakarat.", retuneMs=10)
a("Polo G","rap","melodic","Pop Out;RAPSTAR;Martin & Gina;Heartless;Finer Things","Piyano üstü melodik anlatım.")
a("Lil Durk","rap","trap","All My Life;Laugh Now Cry Later;Broadway Girls;Viral Moment;3 Headed Goat","Belirgin 'warble' — hızlı retune.", retuneMs=5)
a("A Boogie wit da Hoodie","rap","melodic","Drowning;Look Back at It;Swervin;Numbers;Jungle","Melodik New York sesi.", retuneMs=14)
a("Rod Wave","rap","melodic","Heart on Ice;Rags2Riches;Tombstone;Street Runner;Great Gatsby","Soul etkili, güçlü ses; yavaşlat.", retuneMs=30, humanize=15)
a("Kid Cudi","rap","melodic","Day 'n' Nite;Pursuit of Happiness;Erase Me;Soundtrack 2 My Life;Tequila Shots","Mırıldanma ve uzun notalar; geniş reverb.", retuneMs=35, revTime=2.4, revMix=0.3)
a("Ty Dolla $ign","rnb","rnbtune","Paranoid;Or Nah;Blasé;Psycho;Purple Emoji","Katmanlı armoniler: 2. sesi aç.", v2Level=0.3, v2Interval=4)
a("Swae Lee","rap","melodic","Sunflower|D|90;Unforgettable;Black Beatles;Powerglide;Someone Said","Yüksek, havadar ton.", retuneMs=14, hpfHz=120)
a("Trippie Redd","rap","rage","Love Scars;Dark Knight Dummo;Miss the Rage;Topanga;Taking a Walk","Bağıran, doygun vokal.")
a("Yeat","trap","rage","Monëy so big;Talk;Out thë way;Sorry Bout That;Poppin","Rage: sert tune, bol doygunluk.")
a("Ken Carson","trap","rage","Rock N Roll;Yale;Freestyle 2;Fighting My Demons;overseas","Çok doygun, sıkıştırılmış.", satDrive=14, satMix=0.5)
a("Destroy Lonely","trap","rage","NOSTYLIST;If Looks Could Kill;Bane;VTMNTSCOAT;how u feel?","Karanlık, geniş reverb.", revTime=2.4, revMix=0.35, satDrive=6)
a("Lil Yachty","rap","poptune","Minnesota;One Night;Broccoli;Poland;iSpy","'Poland' titremesi için vibratoyu +40 yap.", retuneMs=4, scale="major")
a("NAV","trap","trapdark","Myself;Tap;Turks;Champion;Some Way","Tekdüze, robotik ton.", retuneMs=0)
a("Chief Keef","trap","hard","Love Sosa;I Don't Like;Faneto;Hate Bein' Sober;Kay Kay","Erken drill: ham, sert tune.", satDrive=6, satMix=0.3, revMix=0.12)
a("Akon","rnb","poptune","Smack That;Lonely;Don't Matter;I Wanna Love You;Right Now (Na Na Na)","2000'ler: parlak, hızlı düzeltme.", retuneMs=8)
a("Doja Cat","pop","poptune","Say So|D|111;Kiss Me More;Woman;Paint the Town Red;Streets","Rap ve pop arasında geçiş.", retuneMs=15)
a("Nicki Minaj","rap","poptune","Super Bass;Starships;Anaconda;Moment 4 Life;Super Freaky Girl","Nakaratlarda pop tune.", retuneMs=18)
a("The Kid LAROI","pop","melodic","STAY|C#|170;WITHOUT YOU;Love Again;Thousand Miles;GO","Pop-rap, yüksek enerji.", retuneMs=15, scale="major")
a("Central Cee","rap","melodic","Doja;Sprinter;Loading;Obsessed With You;BAND4BAND","Rap ağırlıklı; neredeyse düz.", retuneMs=40, revMix=0.1)
# ---------- pop ----------
a("Taylor Swift","pop","pop","Blank Space|F|96;Shake It Off|G|160;Anti-Hero|E|97;Love Story|D|119;Cruel Summer|A|170;Cardigan","Net diksiyon; şeffaf düzeltme.")
a("Ariana Grande","pop","pop","7 rings|C#m|140;thank u, next;no tears left to cry|Am|122;Into You|F#m|108;positions;we can't be friends","Geniş aralık, katmanlı arka vokaller.", retuneMs=25, v2Level=0.12, v2Detune=6)
a("Billie Eilish","pop","pop","bad guy|Gm|135;ocean eyes;everything i wanted;Happier Than Ever;lovely|Em|115;BIRDS OF A FEATHER","Finneas vokalleri düzeltme amaçlı tune etmediğini söylüyor; fısıltıya yakın söyle.", retuneMs=60, humanize=40, flex=40, gateDb=-60, hpfHz=80, revMix=0.12, src="billie")
a("Billie Eilish — efekt (Bury a Friend)","pop","hard","bury a friend;listen before i go;when i was older","Bu şarkılarda güçlü, 'Kanye/T-Pain tipi' Auto-Tune efekti var (SOS).", satDrive=6, satMix=0.25, src="billie")
a("Dua Lipa","pop","pop","Levitating|Bm|103;Don't Start Now|Bm|124;New Rules|Am|116;Physical|Am|147;One Kiss|Am|124;Houdini","Koyu alto; disko-pop.", scale="minor", hpfHz=80)
a("Ed Sheeran","pop","pop","Shape of You|C#m|96;Perfect|G#|95;Thinking Out Loud|D|79;Bad Habits|Bm|126;Photograph|E|108","Akustik, doğal.", retuneMs=40)
a("Justin Bieber","pop","poptune","Peaches|C|90;Love Yourself|E|100;Sorry;Baby;Ghost;What Do You Mean?","Pop-R&B parlaklığı.", retuneMs=20, v2Level=0.1)
a("Harry Styles","pop","pop","As It Was|A|174;Watermelon Sugar;Sign of the Times|F|120;Adore You|Cm|99;Late Night Talking","Retro pop-rock.", retuneMs=45)
a("Olivia Rodrigo","pop","pop","drivers license|A#|144;good 4 u;vampire|F|138;deja vu;traitor","Sessiz mısradan bağıran nakarata.", retuneMs=35)
a("Sabrina Carpenter","pop","pop","Espresso|C|104;Please Please Please;Nonsense;Feather;Taste","Hafif, nefesli üst ton.", retuneMs=25, hpfHz=110)
a("Lady Gaga","pop","pop","Poker Face|G#m|119;Bad Romance|Am|119;Shallow|G|96;Just Dance|C#m|119;Abracadabra","Güçlü göğüs sesi.", retuneMs=35)
a("Katy Perry","pop","poptune","Firework;Roar;Teenage Dream;Dark Horse;California Gurls","2010 parlak pop.", retuneMs=18)
a("Rihanna","pop","poptune","Umbrella|A#m|87;Diamonds|Bm|92;We Found Love|F#|128;Stay;Work;Love on the Brain","Karakteristik tını.", retuneMs=22, scale="minor")
a("Britney Spears","pop","poptune","...Baby One More Time|Cm|93;Toxic|Cm|143;Womanizer;Oops!... I Did It Again;Circus","2000'ler: belirgin işlenmiş vokal.", retuneMs=8, v2Level=0.2, v2Detune=10)
a("Miley Cyrus","pop","pop","Flowers|Am|118;Wrecking Ball;Party in the U.S.A.;Midnight Sky;The Climb","Kısık, güçlü alto.", retuneMs=40, hpfHz=80)
a("Selena Gomez","pop","pop","Lose You to Love Me;Calm Down;Come & Get It;Same Old Love;Hands to Myself","Yumuşak, yakın mikrofon.", retuneMs=22)
a("Shawn Mendes","pop","pop","Stitches;Treat You Better;Señorita;There's Nothing Holdin' Me Back;In My Blood","Pop-rock tenor.")
a("Charlie Puth","pop","poptune","Attention|D#m|100;We Don't Talk Anymore;See You Again;Light Switch;How Long","Çok temiz, çiftlenmiş falsetto.", retuneMs=20, v2Level=0.15)
a("Adele","pop","soul","Hello|Fm|79;Someone Like You|A|67;Rolling in the Deep|Cm|105;Easy On Me|F|142;Set Fire to the Rain|Dm|108","Büyük dinamik; düzeltmeyi en aza indir.")
a("Sia","pop","pop","Chandelier;Cheap Thrills;Elastic Heart;Unstoppable;Titanium","Çatlayan ses kırılmalarını koru.", retuneMs=50, humanize=35)
a("Bruno Mars","pop","pop","Just the Way You Are|F|109;Grenade|Dm|110;Locked Out of Heaven|Dm|144;When I Was Your Man|C|73;Die With A Smile","Funk-pop tenor.", retuneMs=40)
a("Coldplay","pop","pop","Yellow;Viva la Vida;Fix You;The Scientist;A Sky Full of Stars","Falsetto + geniş reverb.", retuneMs=45, revTime=2.2, revMix=0.28)
a("Imagine Dragons","pop","pop","Believer;Radioactive;Demons;Thunder;Bones","Bağıran nakarat; 'Thunder' için formantı +3 dene.", retuneMs=35, satDrive=4, satMix=0.2)
a("Maroon 5","pop","poptune","Sugar;Moves Like Jagger;Girls Like You;She Will Be Loved;Memories","Yüksek tenor / falsetto.", retuneMs=20)
a("Halsey","pop","pop","Without Me;Bad at Love;Closer;Colors;Gasoline","Nefesli, işlenmiş.", retuneMs=25)
a("Lana Del Rey","pop","pop","Summertime Sadness;Video Games;Young and Beautiful;Born to Die;West Coast","Alçak, tembel; uzun reverb.", retuneMs=55, humanize=35, revTime=2.8, revMix=0.35, hpfHz=75)
a("Lorde","pop","pop","Royals;Team;Green Light;Ribs;Solar Power","Kuru, katmanlı vokaller.", retuneMs=40, v2Level=0.2, v2Interval=-12, revMix=0.1)
a("Tate McRae","pop","poptune","greedy;you broke me first;exes;she's all i wanna be;Sports car","Nefesli pop-R&B.", retuneMs=18)
a("Chappell Roan","pop","pop","Good Luck, Babe!;Pink Pony Club;HOT TO GO!;Casual;Red Wine Supernova","Teatral, geniş aralık.", retuneMs=45)
a("Benson Boone","pop","pop","Beautiful Things;In the Stars;Slow It Down;Ghost Town;Mystical Magical","Güçlü belting.", retuneMs=45)
a("Sam Smith","pop","soul","Stay With Me;Too Good at Goodbyes;I'm Not the Only One;Unholy;Lay Me Down","Falsetto geçişleri.", retuneMs=50)
a("Michael Jackson","pop","soul","Billie Jean|F#m|117;Beat It|D#m|139;Smooth Criminal;Man in the Mirror;Thriller","Dönem kayıtlarında pitch düzeltme yok; yalnız güvenlik ağı.", retuneMs=60, revMix=0.12)
# ---------- r&b ----------
a("The Weeknd","rnb","rnb","Blinding Lights|Fm|171;Starboy|Am|186;The Hills|Cm|113;Save Your Tears|C|118;Can't Feel My Face|Am|108;Die For You","Illangelo: zincir Auto-Tune EFX ile başlıyor ama çok hafif uygulanıyor.", retuneMs=28, humanize=20, revTime=2.2, revMix=0.3, dlyDiv=0.5, dlyMix=0.12, src="weeknd")
a("Frank Ocean","rnb","rnb","Thinkin Bout You;Pink + White;Nights;Ivy;Chanel","'Nikes' tarzı için formantı +4, retune 0 yap.", retuneMs=40)
a("SZA","rnb","rnb","Kill Bill|G#|89;Snooze;Good Days;The Weekend;Love Galore","Kaygan, konuşur gibi melodiler: yavaş retune.", retuneMs=45, humanize=35)
a("Bryson Tiller","rnb","rnbtune","Don't;Exchange;Sorry Not Sorry;Right My Wrongs;Whatever She Wants","Trap-soul.")
a("PARTYNEXTDOOR","rnb","rnbtune","Come and See Me;Recognize;Break from Toronto;Loyal;Not Nice","Karanlık, sisli; hızlı tune.", retuneMs=8, revMix=0.35)
a("Chris Brown","rnb","poptune","With You;Forever;No Guidance;Under the Influence;Loyal","Parlak, katmanlı.", retuneMs=18, scale="minor", v2Level=0.15)
a("Usher","rnb","rnb","Yeah!;U Got It Bad;Burn;Confessions Part II;OMG","2000'ler R&B.", retuneMs=30)
a("Ne-Yo","rnb","rnb","So Sick;Because of You;Miss Independent;Closer;Sexy Love","Temiz tenor.", retuneMs=28)
a("Beyoncé","rnb","soul","Halo|A|80;Crazy in Love|Dm|99;Single Ladies|E|97;Love On Top|C|94;Irreplaceable","Güçlü, çevik; düzeltme en azda.", retuneMs=55)
a("Khalid","rnb","rnb","Location;Young Dumb & Broke;Talk;Better;Saved","Rahat bariton.", hpfHz=75)
a("H.E.R.","rnb","rnb","Best Part;Focus;Damage;Hard Place;Slide","Sıcak, yakın.")
a("Summer Walker","rnb","rnb","Girls Need Love;Playing Games;Come Thru;No Love;Session 32","Mırıltılı, lo-fi.", retuneMs=30, satDrive=3, satMix=0.15)
a("Brent Faiyaz","rnb","rnb","Dead Man Walking;Trust;Gravity;ALL MINE;Clouded","Katmanlı falsetto armoniler.", v2Level=0.25, v2Interval=4)
a("Daniel Caesar","rnb","soul","Best Part;Get You;Japanese Denim;Always;Superpowers","Gospel etkili, doğal.", retuneMs=55)
a("Giveon","rnb","rnb","Heartbreak Anniversary;Like I Want You;For Tonight;Stuck on You;Lie Again","Derin bariton: ses aralığını 'Kalın erkek' yap.", hpfHz=65)
a("Jhené Aiko","rnb","rnb","Sativa;The Worst;While We're Young;Triggered;P*$$y Fairy (OTW)","Havadar, hafif.", retuneMs=28, hpfHz=120)
a("Kehlani","rnb","rnb","Gangsta;Nights Like This;Honey;After Hours;Distraction","Çevik süslemeler.", retuneMs=32)
a("6LACK","rnb","rnbtune","PRBLMS;Pretty Little Fears;Ex Calling;Switch;Free","Alçak, karanlık.", retuneMs=18, hpfHz=75)
a("Tinashe","rnb","poptune","2 On;Nasty;All Hands on Deck;Company;Needs","Nefesli pop-R&B.", scale="minor")
a("Jeremih","rnb","rnbtune","Birthday Sex;Don't Tell 'Em;oui;Planez;Down on Me","Parlak falsetto.", retuneMs=12)
a("Miguel","rnb","rnb","Adorn;Sure Thing|B|81;Sky Walker;Coffee;How Many Drinks?","Soul-rock tını.", retuneMs=40)
a("Alicia Keys","rnb","soul","If I Ain't Got You;No One;Fallin';Girl on Fire;Empire State of Mind (Part II)","Ham, piyano başında.")
# ---------- soul ----------
a("Aretha Franklin","soul","soul","Respect;I Say a Little Prayer;(You Make Me Feel Like) A Natural Woman;Think;Chain of Fools","Pitch düzeltme öncesi dönem; preset yalnızca hafif güvenlik ağı.", retuneMs=90, humanize=60, flex=60)
a("Stevie Wonder","soul","soul","Superstition;Isn't She Lovely;Sir Duke;I Just Called to Say I Love You;Signed, Sealed, Delivered","Düzeltme öncesi dönem.", retuneMs=90, humanize=60, flex=60)
a("Whitney Houston","soul","soul","I Will Always Love You;I Wanna Dance with Somebody;Greatest Love of All;How Will I Know;I Have Nothing","Uzun, vibratolu notalar: vibratoyu koru.", retuneMs=90, humanize=70, flex=60)
a("Marvin Gaye","soul","soul","What's Going On;Let's Get It On;Sexual Healing;I Heard It Through the Grapevine;Ain't No Mountain High Enough","Düzeltme öncesi dönem.", retuneMs=90, humanize=60, flex=60)
a("Amy Winehouse","soul","soul","Rehab;Back to Black;Valerie;You Know I'm No Good;Tears Dry on Their Own","Caz fraze: geriden gelen, kaygan.", retuneMs=90, humanize=60, flex=60, revMix=0.16)
a("Sam Cooke","soul","soul","A Change Is Gonna Come;Wonderful World;Bring It On Home to Me;Cupid;You Send Me","Düzeltme öncesi dönem.", retuneMs=90, humanize=60, flex=60)
a("Etta James","soul","soul","At Last;I'd Rather Go Blind;Something's Got a Hold on Me;A Sunday Kind of Love;Tell Mama","Düzeltme öncesi dönem.", retuneMs=90, humanize=60, flex=60)
a("Al Green","soul","soul","Let's Stay Together;Tired of Being Alone;Love and Happiness;How Can You Mend a Broken Heart;I'm Still in Love with You","Yumuşak falsetto.", retuneMs=90, humanize=60, flex=60)
a("Leon Bridges","soul","soul","River;Coming Home;Beyond;Texas Sun;Bad Bad News","Retro soul.")
# ---------- afro ----------
a("Burna Boy","afro","afro","Last Last;Ye;On the Low;City Boys;Location","Kalın bariton.", hpfHz=75, retuneMs=18)
a("Wizkid","afro","afro","Essence;Ojuelegba;Come Closer;Joro;Soco","Rahat, yumuşak.", retuneMs=14)
a("Rema","afro","afro","Calm Down|B|107;Dumebi;Soundgasm;Charm;Woman","Yüksek, esnek melodiler.", retuneMs=8)
a("Tems","afro","rnb","Free Mind;Higher;Me & U;Damages;Love Me JeJe","Derin alto; doğal.", scale="major", hpfHz=75)
a("Davido","afro","afro","Fall;If;Unavailable;FEEL;Assurance","Kısık, enerjik.", retuneMs=12)
a("Tyla","afro","poptune","Water;Truth or Dare;ART;Jump;Push 2 Start","Amapiano-pop; nefesli.", retuneMs=18)
# ---------- latin ----------
a("Bad Bunny","latin","latin","Tití Me Preguntó;Me Porto Bonito;DÁKITI;Callaíta;MONACO;DtMF","Alçak, genizden bariton.", hpfHz=75)
a("J Balvin","latin","latin","Mi Gente;Ginza;Ay Vamos;Safari;LA CANCIÓN","Rahat reggaeton.", retuneMs=14)
a("Rauw Alejandro","latin","latin","Todo de Ti;Tattoo;Punto 40;LOKERA;Desesperados","Pop-R&B'ye yakın, parlak.", retuneMs=12, scale="major")
a("Karol G","latin","latin","TQG;PROVENZA;BICHOTA;Tusa;Si Antes Te Hubiera Conocido","Parlak pop-reggaeton.", retuneMs=15)
a("Ozuna","latin","latin","Taki Taki;Baila Baila Baila;Se Preparó;Caramelo;El Farsante","Yüksek, tatlı tenor: sert tune.", retuneMs=5, hpfHz=120)
a("Shakira","latin","pop","Hips Don't Lie;Whenever, Wherever;Waka Waka;La Tortura;Bzrp Music Sessions, Vol. 53","Kendine özgü vibrato: vibratoyu koru.", retuneMs=45, humanize=40)
a("ROSALÍA","latin","pop","MALAMENTE;DESPECHÁ;LA FAMA;Con Altura;SAOKO","Flamenko süslemeleri için kromatik dene.", retuneMs=25, scale="minor")
a("Daddy Yankee","latin","latin","Gasolina;Con Calma;Dura;Limbo;Despacito","Rap ağırlıklı klasik reggaeton.", retuneMs=25)
# ---------- k-pop ----------
a("BTS","kpop","kpop","Dynamite|C#m|114;Butter;Boy With Luv;Spring Day;DNA;Fake Love","Çok katmanlı grup vokalleri.")
a("BLACKPINK","kpop","kpop","DDU-DU DDU-DU;Kill This Love;How You Like That;Pink Venom;As If It's Your Last","Sert, parlak.", retuneMs=15)
a("NewJeans","kpop","kpop","Hype Boy;Ditto;OMG;Super Shy;Attention","Yumuşak, nefesli.", retuneMs=28, compRatio=2.5)
a("Jung Kook","kpop","kpop","Seven|B|125;Standing Next to You;3D;Euphoria;Still With You","Pop-R&B tenor.", retuneMs=20)
# ---------- dance / alternatif ----------
a("Daft Punk — One More Time","dance","dance","One More Time|D|123;Digital Love;Harder, Better, Faster, Stronger;Instant Crush;Get Lucky","Vokal bilerek ağır Auto-Tune ve kompresyondan geçirilmiş.", retuneMs=0, compRatio=8, compThr=-26, src="daftpunk")
a("Bon Iver — Woods / Messina","alt","prism","Woods;715 - CRΣΣKS;Skinny Love;Holocene;Hey, Ma","'Messina': Auto-Tune + harmonizer zinciri, armoni canlı üretilir. Buradaki tek armoni sesi bir yaklaşım.", src="boniver")
a("Charli XCX","pop","hyper","360;Apple;Von dutch;Boom Clap;Speed Drive;Guess","Kayıtta, yazarken ve sahnede hep Auto-Tune ile söylediğini anlatıyor.", formant=0, retuneMs=3, src="charli")
a("100 gecs","alt","hyper","money machine;stupid horse;hand crushed by a mallet;Hollywood Baby;mememe","Formantı +4'e kadar çıkar.", formant=4, satDrive=12, satMix=0.5)
a("James Blake","alt","prism","Retrograde;Limit to Your Love;The Wilhelm Scream;Mile High;Say What You Will","Katmanlı, işlenmiş falsetto.", retuneMs=25, v2Interval=-12, v2Level=0.3)
a("Imogen Heap — Hide and Seek","alt","prism","Hide and Seek;Headlock;Goodnight and Go;Speeding Cars;Just for Now","Harmonizer ile çok sesli a cappella; tek armoni sesi yaklaşımı.", retuneMs=10, v2Interval=4, v2Level=0.7)
a("Black Eyed Peas","dance","dance","I Gotta Feeling;Boom Boom Pow;Where Is the Love?;Meet Me Halfway;Pump It","2009 elektro-pop: sert, robotik.", retuneMs=0)
a("Calvin Harris","dance","dance","Summer;Feel So Close;This Is What You Came For;One Kiss|Am|124;Slide","EDM vokali.", retuneMs=10)
a("David Guetta","dance","dance","Titanium;When Love Takes Over;Without You;I'm Good (Blue);Memories","Büyük salon reverb'ü.", retuneMs=12, revTime=2.4, revMix=0.3)
a("Eiffel 65","dance","dance","Blue (Da Ba Dee);Move Your Body;Too Much of Heaven;Lucky (In My Life);My Console","1999 eurodance: tam robotik.", retuneMs=0, v2Level=0)
a("Tame Impala","alt","pop","The Less I Know the Better;Let It Happen;Feels Like We Only Go Backwards;Borderline;New Person, Same Old Mistakes","Çiftlenmiş, psikedelik; bol delay.", retuneMs=35, v2Level=0.3, v2Detune=12, dlyMix=0.2, dlyDiv=0.5, revMix=0.3)
a("Cher (2. preset: yumuşak)","pop","pop","If I Could Turn Back Time;Strong Enough;The Shoop Shoop Song;Song for the Lonely","Efektsiz Cher şarkıları için.", retuneMs=40)
# ---------- Türkçe ----------
a("Ezhel","tr","melodic","Geceler;Felaket;Şehrimin Tadı;Olay;AYA;Bul Beni","Melodik Türkçe rap; reggae etkili.", retuneMs=14)
a("Uzi","tr","trap","Umrumda Değil;Makina;Krvn;Paparazzi;Arasan da","Türkçe trap/drill.", retuneMs=10)
a("Murda","tr","trap","Eh Baba;AYA;Pahalı;İmdat;Güneş","Hollanda etkili melodik trap.", retuneMs=8)
a("Ben Fero","tr","melodic","Demet Akalın;3 2 1;Biladerim İçin;Babafingo;Mahallemiz Esmer","Rap ağırlıklı.", retuneMs=30, revMix=0.12)
a("Semicenk","tr","melodic","Herkes Gibisin;Pişman Değilim;Canın Sağ Olsun;Unutmak Öyle Kolay mı Sandın","Duygusal pop-rap; alaturka süslemeler için kromatik.", retuneMs=22, scale="chromatic")
a("Edis","tr","poptune","Martılar;Arıyorum;Çok Çok;Dudak;Benim Ol","Modern Türkçe pop.", retuneMs=20)
a("Zeynep Bastık","tr","pop","Felaket;Uslanmıyor Bu;Ara;Marlon Brando;Lan","Pop; şeffaf.", retuneMs=30)
a("Mabel Matiz","tr","arabesk","Öyle Kolaysa;Gel;Fırtınadayım;Sarmaşık;Antidepresan","Gırtlak süslemeleri: yavaş, kromatik.", retuneMs=60)
a("Tarkan","tr","pop","Şımarık;Kuzu Kuzu;Dudu;Hüp;Yolla;Kedi Gibi","Türk pop; süslemelerde kromatik dene.", retuneMs=40)
a("Sezen Aksu","tr","arabesk","Gülümse;Firuze;Hadi Bakalım;Kaybolan Yıllar;Geri Dön;Seni Kimler Aldı","Düzeltmeyi en azda tut; makam geçkilerini 12 ton bozar.", retuneMs=100)
a("Sertab Erener","tr","pop","Everyway That I Can;Olsun;Aşk;Rengarenk;Kumsalda","Geniş aralıklı soprano: ses aralığını 'Soprano' yap.", retuneMs=45)
a("Cem Adrian","tr","arabesk","Sen Benim Şarkılarımsın;Yalnızlık;Ben Seni Çok Sevdim;Kül;Mutlu Yıllar","Çok geniş ses aralığı; doğal.", retuneMs=80)
a("Müslüm Gürses","tr","arabesk","Affet;İtirazım Var;Nilüfer;Sensiz Olmaz;Hangimiz Sevmedik","Arabesk: koma sesleri var, düzeltme neredeyse kapalı.", retuneMs=140, humanize=70, flex=70)
a("Barış Manço","tr","arabesk","Gülpembe;Dağlar Dağlar;Sarı Çizmeli Mehmet Ağa;Dönence;Kara Sevda","Anadolu rock; doğal.", retuneMs=90)

TOK = dict(b="bodyDb", p="presDb", a="airDb", lp="lpfHz", rm="revMix", rt="revTime", rd="revDamp", dm="dlyMix", dd="dlyDiv", df="dlyFb", sd="satDrive", sm="satMix",
           fm="formant", t="retuneMs", cr="compRatio", hp="hpfHz", vb="vibrato", tr="transpose", m="mode", hu="humanize", fx="flex")
def tweak(spec):
    o = {}
    for tok in spec.split():
        m = re.match(r"^([a-z]+)([+-]?[0-9.]+)$", tok); assert m, tok
        k, v = m.group(1), float(m.group(2)); v = int(v) if v == int(v) else v
        if k == "dl": o.update(v2Level=v, v2Interval=0, v2Detune=10)       # double
        elif k == "oc": o.update(v2Level=v, v2Interval=-12, v2Detune=0)    # octave below
        elif k == "hm": o.update(v2Level=v, v2Interval=4, v2Detune=0)      # harmony (third)
        elif k == "hf": o.update(v2Level=v, v2Interval=-5, v2Detune=0)     # harmony (fourth below)
        elif k in ('b', 'p', 'a'): o[TOK[k]] = max(-9, min(9, round(v * 1.6 * 2) / 2))   # bold enough to hear
        else: o[TOK[k]] = v
    return o
TW = {
 "Drake": "a4 p2 b-1 rm.12 dm.1 t22", "Lil Wayne": "sd8 sm.35 p3 a1 rm.1", "Young Thug": "t3 a3 p2 dm.18 dd.5 vb25", "Gunna": "t12 b1 a2 rm.18 dl.15", "Lil Baby": "t15 p3 a2 rm.1 dm.08 cr5",
 "Quavo / Migos": "t5 dl.2 a3 dm.2 dd.75", "21 Savage": "t25 b3 a-2 lp11000 rm.08 dm.05", "Juice WRLD": "t12 a3 rm.28 rt2.2 dm.15", "XXXTentacion": "lp5500 sd8 sm.35 b2 rm.12", "Lil Nas X": "cr8 a4 p2 dl.15",
 "Roddy Ricch": "t8 a3 rm.22 dm.18 dd.75 vb15", "Polo G": "t18 b1 a2 rm.2", "Lil Durk": "t4 p3 a2 dm.12 rm.12", "A Boogie wit da Hoodie": "t12 a4 dl.2 rm.22", "Rod Wave": "t28 b3 p1 rm.25 rt2",
 "Kid Cudi": "t35 b2 a-2 rm.35 rt2.8 oc.2", "Ty Dolla $ign": "hm.35 b2 rm.25", "Swae Lee": "a6 b-2 hp130 t12 rm.25", "Trippie Redd": "sd12 sm.45 p3 rm.25", "Yeat": "t2 m1 fm-1.5 sd10 sm.4 rm.3 rt2",
 "Ken Carson": "sd16 sm.6 lp7000 cr6 rm.2", "Destroy Lonely": "rm.4 rt3 rd.8 a-2 sd6 sm.25 dm.2 lp10000", "Lil Yachty": "t3 a5 hp130 vb35", "NAV": "t0 lp10000 a-1 rm.25", "Chief Keef": "t0 sd8 sm.35 lp8000 rm.08",
 "Akon": "t8 a5 p2 hp120 rm.15 dl.12", "Doja Cat": "t15 a4 dl.15 rm.18", "Nicki Minaj": "t18 p3 a3 rm.12 dm.1", "The Kid LAROI": "t12 a3 p2 sd4 sm.2 rm.2", "Central Cee": "t40 rm.06 dm0 p2 b1",
 "Taylor Swift": "t40 a3 p1 rm.2 rt1.8 dl.1", "Ariana Grande": "t25 a6 b-1 dl.18 rm.25 rt2", "Billie Eilish": "b2 a2 rm.08 cr5 dl.15", "Billie Eilish — efekt (Bury a Friend)": "lp6000 sd8 sm.35 oc.3 rm.1",
 "Dua Lipa": "b3 p1 a2 rm.2 dm.1 dd.5", "Ed Sheeran": "t40 b1 p1 rm.12 dm0", "Justin Bieber": "t18 a5 dl.15 rm.2 dm.1", "Harry Styles": "t45 rm.25 rt1.2 dm.15 dd.25 sd3 sm.15", "Olivia Rodrigo": "t35 p3 a2 rm.18 sd3 sm.15",
 "Sabrina Carpenter": "t22 a6 hp120 dl.15 rm.22", "Lady Gaga": "t35 p3 b1 rm.25 rt2.2", "Katy Perry": "t15 a5 p3 dl.2 rm.2", "Rihanna": "t20 p3 a2 b1 rm.2 dm.12", "Britney Spears": "t6 m1 fm1 dl.25 a5 p2 hp130",
 "Miley Cyrus": "t40 b3 sd4 sm.2 a1 rm.2", "Selena Gomez": "t20 a4 b1 cr4 rm.12", "Shawn Mendes": "t30 p2 rm.2 dm.08", "Charlie Puth": "t18 dl.2 a5 rm.12 dm.05", "Adele": "t70 b2 p2 rm.3 rt2.6",
 "Sia": "t50 p4 sd3 sm.15 rm.28 rt2.4", "Bruno Mars": "t40 p2 a2 rm.2 rt1.4 dm.1 dd.25", "Coldplay": "t45 a3 rm.35 rt2.8 dm.2 dd.75", "Imagine Dragons": "sd6 sm.3 p3 rm.3 rt2.4 oc.2", "Maroon 5": "t20 a5 hp130 b-2 rm.15",
 "Halsey": "t25 a3 sd3 sm.15 rm.25 dm.12", "Lana Del Rey": "t55 b3 a-1 rm.45 rt3.2 rd.6 dm.1", "Lorde": "t40 oc.25 rm.08 b2", "Tate McRae": "t18 a5 cr4 rm.15", "Chappell Roan": "t45 p2 a2 rm.28 rt2.2 dm.1",
 "Benson Boone": "t45 p3 rm.25 rt2", "Sam Smith": "t50 a2 b1 rm.3 rt2.4", "Michael Jackson": "t60 p3 a2 rm.15 rt1 dm.12 dd.25",
 "The Weeknd": "t28 a4 rm.35 rt2.6 rd.6 dm.15 dd.5 dl.1", "Frank Ocean": "t40 b1 a1 rm.15 dm.05", "SZA": "t45 b1 a3 rm.22 dm.1 dd.75 dl.12", "Bryson Tiller": "t14 a2 lp12000 rm.3 dm.18", "PARTYNEXTDOOR": "t8 lp8000 rm.4 rt2.8 b2",
 "Chris Brown": "t18 a5 dl.2 p2 rm.18", "Usher": "t30 a3 p1 rm.2 dl.1", "Ne-Yo": "t28 a4 hp110 rm.18", "Beyoncé": "t55 p2 a3 rm.22 rt1.8 dl.12", "Khalid": "t35 b3 a1 rm.25 rt2",
 "H.E.R.": "t35 b2 rm.2 dm.08", "Summer Walker": "t30 lp10000 sd3 sm.15 rm.25 b1", "Brent Faiyaz": "hm.3 a2 rm.12 lp13000", "Daniel Caesar": "t55 b1 a2 rm.28 rt2.4", "Giveon": "t35 b5 a-1 hp60 rm.22",
 "Jhené Aiko": "t28 a6 b-2 hp130 rm.3 rt2.4 dm.15", "Kehlani": "t32 a3 p1 rm.18 dl.12", "6LACK": "t18 b3 lp9000 rm.25 dm.15", "Tinashe": "t18 a5 hp120 dl.15 rm.2", "Jeremih": "t12 a5 hp120 rm.25 dm.15 dd.75",
 "Miguel": "t40 sd4 sm.2 p2 rm.28 dm.15 dd.25", "Alicia Keys": "t70 b1 p2 rm.2 rt1.6",
 "Aretha Franklin": "p3 rm.2 rt1.2", "Stevie Wonder": "a2 dl.1 rm.15", "Whitney Houston": "p2 a3 rm.35 rt2.8", "Marvin Gaye": "dl.25 rm.2 a1", "Amy Winehouse": "sd4 sm.2 lp11000 rm.25 rt1.6 dm.1 dd.25",
 "Sam Cooke": "lp9000 b1 rm.3 rt1.8", "Etta James": "lp9000 sd3 sm.15 p2 rm.25", "Al Green": "a2 b2 rm.1", "Leon Bridges": "lp10000 rm.25 dm.12 dd.25",
 "Burna Boy": "b4 a1 rm.18 dm.12", "Wizkid": "a3 b1 rm.22 dm.15 t14", "Rema": "t8 a5 hp120 dl.12 dm.18", "Tems": "b4 a1 rm.25 rt2", "Davido": "sd4 sm.2 p3 t12 rm.15", "Tyla": "a6 hp120 cr4 rm.22 dl.12",
 "Bad Bunny": "b4 a1 t8 lp13000 rm.2 dm.12", "J Balvin": "t14 a2 b1 rm.18 dl.1", "Rauw Alejandro": "t10 a5 dl.18 rm.22", "Karol G": "a4 p2 rm.2 dm.12", "Ozuna": "t5 a6 hp130 b-2 rm.25",
 "Shakira": "vb20 p3 a2 rm.2", "ROSALÍA": "t20 a4 p2 sd3 sm.15 rm.15 dl.15", "Daddy Yankee": "t25 p4 a2 rm.08 dm.08 cr5",
 "BTS": "dl.2 a4 rm.2", "BLACKPINK": "p4 a4 cr5 rm.12 sd3 sm.15", "NewJeans": "a5 b-1 cr2.5 rm.25 lp14000", "Jung Kook": "a5 dl.12 rm.22 dm.1",
 "Daft Punk — One More Time": "sd4 sm.2 p3 lp9000", "Charli XCX": "a5 p2 sd5 sm.25 dl.2", "100 gecs": "lp12000", "Black Eyed Peas": "p3 lp9000 sd5 sm.3", "Calvin Harris": "a5 rm.3", "David Guetta": "a4 rm.35 rt2.6",
 "Eiffel 65": "lp8000 p4 a2", "Tame Impala": "lp9000 dl.3 dm.25 rm.3 sd4 sm.2", "James Blake": "b2 lp12000 rm.35 rt3", "Imogen Heap — Hide and Seek": "a3 rm.15",
 "Ezhel": "t14 b2 a2 rm.18 dm.15 dd.75", "Uzi": "t10 p3 sd4 sm.2 rm.15", "Murda": "t8 a4 dl.12 rm.25 dm.15", "Ben Fero": "p3 cr5 rm.1 dm0", "Semicenk": "t22 rm.3 rt2.4 a2 b1",
 "Edis": "t20 a5 dl.15 rm.2", "Zeynep Bastık": "t30 a3 p1 rm.2", "Mabel Matiz": "t60 p2 rm.25 dm.1", "Tarkan": "t40 p3 a2 rm.22 rt1.6 dl.1", "Sezen Aksu": "t100 b1 p1 rm.3 rt2.4",
 "Sertab Erener": "t45 a3 p2 rm.28 rt2.4", "Cem Adrian": "t80 rm.35 rt3 b1", "Müslüm Gürses": "t140 b3 lp10000 rm.3 rt2 dm.1", "Barış Manço": "t90 lp10000 b2 rm.2 dm.12 dd.25",
}
a("Roisee — Am I Dreaming","rnb","rnb","Am I Dreaming|Am","Havadar, katmanlı ve bol reverb'lü nakarat (Metro Boomin, Spider-Verse). Ton kaynağı: lisanslı karaoke sürümü 'orijinalle aynı ton: Am'.", retuneMs=20, humanize=10, flex=0, src="roisee")
TW["Roisee — Am I Dreaming"] = "a6 b-1 hp120 dl.25 rm.45 rt3.2 rd.4 dm.15 dd.75"
a("Frank Ocean — Nikes (perde +5)","rnb","hard","Nikes;Self Control;Futura Free","'Nikes'ta vokal 5 yarım ton yukarı kaydırılmış (Frank'in kendi '-5' canlı sürümü bunu doğruluyor). Formant da kaydığı için düşük gecikme modu.", src="nikes", scale="major")
TW["Frank Ocean — Nikes (perde +5)"] = "tr5 m0 t10 rm.25 rt2 a2 dm.08"
for x in A:
    if x["name"] in TW: x["o"].update(tweak(TW[x["name"]]))
missing = [x["name"] for x in A if x["name"] not in TW]
print("artists without a signature tweak:", missing)

SRC = {
 "lilnasx": [["Sound On Sound: Lil Nas X vokal zinciri (Auto-Tune EFX … L2)", "https://www.soundonsound.com/node/4920422?page=2"]],
 "billie": [["Sound On Sound: Finneas — Billie Eilish prodüksiyonu", "https://www.soundonsound.com/people/billie-eilish?page=2"], ["Tape Op: Finneas O'Connell", "https://new.tapeop.com/interviews/165/finneas-oconnell"]],
 "weeknd": [["Sound On Sound: Inside Track — The Weeknd (Illangelo)", "https://www.soundonsound.com/techniques/inside-track-weeknd"], ["Equipboard: The Weeknd vokal zinciri", "https://equipboard.com/pros/the-weeknd"]],
 "daftpunk": [["Wikipedia: One More Time (Daft Punk)", "https://en.wikipedia.org/wiki/One_More_Time_(Daft_Punk_song)"], ["Bjango: Daft Punk vokal efektleri", "https://bjango.com/articles/daftpunkvocaleffects/"]],
 "boniver": [["W Magazine: Chris Messina ve 'The Messina'", "https://www.wmagazine.com/story/the-engineer-behind-bon-ivers-22-a-million-clears-up-any-confusion-about-its-high-tech-sound/amp"], ["Antares: Bon Iver canlı vokal sesleri", "https://www.antarestech.com/blog/bon-iver-vocal-sounds-live"], ["Red Bull: Auto-Tune tarihi (Woods)", "https://www.redbull.com/us-en/history-of-auto-tune-in-seven-songs"]],
 "roisee": [["Wikipedia: Am I Dreaming (Metro Boomin, A$AP Rocky & Roisee)", "https://en.wikipedia.org/wiki/Am_I_Dreaming_(Metro_Boomin,_ASAP_Rocky_and_Roisee_song)"], ["KaraFun: ton (Am)", "https://www.karafun.co.uk/karaoke/spider-man-across-the-spider-verse/am-i-dreaming/"]],
 "nikes": [["Hypebeast: Frank Ocean 'Nikes' canlı stüdyo sürümü (“-5”)", "https://hypebeast.com/2017/9/frank-ocean-nikes-live-studio"]],
 "drake": [["Rolling Stone: Noah '40' Shebib", "https://www.rollingstone.com/music/music-features/noah-40-shebib-profile-1011388/"], ["Sound On Sound: 40 — Drake 'Headlines'", "https://www.soundonsound.com/techniques/noah-40-shebib-recording-drakes-headlines"]],
 "thug": [["Cambridge (Popular Music): Young Thug ve Auto-Tune", "https://www.cambridge.org/core/product/C5B160BE7E8AB29576E92CC7CD9D60B7"]],
 "charli": [["MusicRadar: Charli XCX ve Auto-Tune", "https://musicradar.com/news/charli-xcx-auto-tune-brat"], ["FADER: Charli XCX & A. G. Cook", "https://thefader.com/2017/12/15/charli-xcx-a-g-cook-pop-2-interview"]],
}
out = []
for x in A:
    src = x["o"].pop("src", None)
    e = dict(name=x["name"], g=x["g"], s=x["s"], o=x["o"], note=x["note"], songs=x["songs"])
    if src: e["src"] = SRC[src]
    out.append(e)
# songs + genre for the 12 fully documented presets in presets.json
LEGACY = {
 "tpain": ["rnb", "Buy U a Drank;Bartender;I'm Sprung;Can't Believe It;I'm N Luv (Wit a Stripper)"],
 "cher": ["pop", "Believe|F#|133"],
 "kanye808": ["rap", "Heartless|A#m|88;Love Lockdown;Say You Will;Paranoid;Street Lights;RoboCop"],
 "future": ["trap", "Mask Off;Draco;March Madness;Life Is Good;Low Life;Used to This"],
 "uzi": ["trap", "XO Tour Llif3;The Way Life Goes;20 Min;Sauce It Up;Just Wanna Rock"],
 "travis": ["trap", "goosebumps;SICKO MODE;Antidote;HIGHEST IN THE ROOM;FE!N;BUTTERFLY EFFECT"],
 "postmalone": ["pop", "Circles|C|120;Sunflower|D|90;rockstar;Congratulations;Better Now;I Had Some Help"],
 "carti": ["trap", "Magnolia;Sky;Shoota;@ MEH;Stop Breathing;Location"],
 "toliver": ["rnb", "No Idea;After Party;Lemonade;Private Landing;Bandit"],
 "adlib": ["trap", ""], "melodictrap": ["trap", ""], "natural": ["pop", ""],
}
GENRES = {"rap":"Rap","trap":"Trap","pop":"Pop","rnb":"R&B","soul":"Soul","afro":"Afrobeats","latin":"Latin","kpop":"K-pop","dance":"Dance","alt":"Alternatif","tr":"Türkçe"}
json.dump(dict(base=BASE, styles={k: dict(label=v[0], o=v[1]) for k, v in STYLES.items()}, genres=GENRES, legacy=LEGACY, artists=out),
          open("artists.json", "w"), ensure_ascii=False, separators=(",", ":"))
bad = [x["name"] for x in out if x["s"] not in STYLES or x["g"] not in GENRES or len(x["songs"]) < 1]
print(len(out), "artists +", len(LEGACY), "legacy =", len(out) + len(LEGACY), "| songs:", sum(len(x["songs"]) for x in out), "| bad:", bad)
from collections import Counter; print(Counter(x["g"] for x in out))
