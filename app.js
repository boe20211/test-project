document.addEventListener('DOMContentLoaded', () => {
    // Initialize Lucide Icons
    lucide.createIcons();

    // --- State Management ---
    const state = {
        seaLevel: 0,           // Current simulated sea level in meters
        scenario: 'normal',    // 'normal', 'spring-tide', 'storm-surge'
        scenarioOffset: 0,     // Additional sea level offset in meters
        isExtremeMode: false,  // If true, max slider is 500m, else 100m
        isPlaying: false,      // Animation playing state
        animationInterval: null,
        elevationData: null,   // Elevation pixel array
        totalLandPixels: 0,    // Total land pixels in the image
        elevationHistogram: new Int32Array(4000), // Histogram of land elevations (0 to 3999m)
        bracketTotalPixels: new Int32Array(8),    // Total pixels per population bracket
        bracketFloodedPixels: new Int32Array(8),  // Flooded pixels per population bracket (connected-aware)
        floodedLandPixels: 0,                     // Total flooded land pixels (connected-aware)
        elevationBounds: null, // Geographic bounds from JSON
        imgWidth: 0,
        imgHeight: 0,
        mapLoaded: false,
        dataLoaded: false,
        
        // --- New States for Flood Defense & Calibration ---
        enableDefenses: false,
        leveeHeight: 6,        // in meters
        scaleFactor: 1.0,
        offsetCorrection: 0.0,
        isDrawingLevee: false,
        leveePolylines: [],    // Leaflet polyline layer references
        leveeCoordsList: [],   // Array of coordinate arrays [{lat, lng}, ...]
        defenseData: null,     // Uint8Array representing defense heights per pixel
        oceanPixelIndices: null, // Cached indices of ocean pixels for optimized BFS seeding
        
        // --- Scientific Decoding & Masking ---
        decodingMode: 'normalized', // 'direct' or 'normalized'
        maxElevation: 4000,         // in meters, for normalized decoding range
        minElevation: 0,            // in meters, for normalized decoding range
        constraintMask: null        // Uint8Array for preloaded impenetrable barrier mask
    };

    // Helper to calculate the cumulative sea level rise
    function getEffectiveSeaLevel() {
        return state.seaLevel + state.scenarioOffset;
    }

    // Update the UI badge for the cumulative effective sea level
    function updateEffectiveSeaLevelUI() {
        const effectiveVal = getEffectiveSeaLevel();
        if (state.scenarioOffset > 0) {
            effectiveSeaLevelContainer.style.display = 'inline-flex';
            if (mslValDisplay) mslValDisplay.textContent = state.seaLevel;
            if (tideOffsetValDisplay) tideOffsetValDisplay.textContent = `+${state.scenarioOffset.toFixed(1)}m`;
            if (effectiveSeaLevelVal) effectiveSeaLevelVal.textContent = effectiveVal.toFixed(1);
        } else {
            effectiveSeaLevelContainer.style.display = 'none';
        }
    }

    // Helper to calculate the calibrated elevation (with defenses optional)
    function getElevationAtOffset(offset) {
        if (!state.elevationData) return 0;
        const r = state.elevationData[offset];
        const g = state.elevationData[offset + 1];
        const rawVal = r * 256 + g;
        
        let elevation = 0;
        if (state.decodingMode === 'normalized') {
            // Scientific linear mapping: 16-bit [0-65535] mapped to [minElevation, maxElevation] (6.1cm resolution)
            const normVal = (rawVal / 65535.0) * (state.maxElevation - state.minElevation) + state.minElevation;
            elevation = normVal * state.scaleFactor - state.offsetCorrection;
        } else {
            // Direct translation: 1 unit = 1 meter (1m vertical precision)
            elevation = rawVal * state.scaleFactor - state.offsetCorrection;
        }
        
        // Adjust for defenses if enabled
        if (state.enableDefenses) {
            const pixelIdx = offset / 4;
            
            // A. Impenetrable Constraint Mask (pre-loaded barrier layer)
            if (state.constraintMask && state.constraintMask[pixelIdx] === 1) {
                return 9999; // Impenetrable height
            }
            
            // B. Overtoppable Custom-Drawn Levee Barrier (finite height barrier)
            if (state.defenseData) {
                const defenseHeight = state.defenseData[pixelIdx];
                if (defenseHeight > 0) {
                    elevation = Math.max(elevation, defenseHeight);
                }
            }
        }
        
        return elevation;
    }

    // --- DOM Elements ---
    const slider = document.getElementById('sea-level-slider');
    const valDisplay = document.getElementById('sea-level-val');
    const extremeToggle = document.getElementById('extreme-mode');
    const btnPlay = document.getElementById('btn-play');
    const playText = document.getElementById('play-text');
    const btnReset = document.getElementById('btn-reset');

    // Stats Elements
    const statFloodedPercent = document.getElementById('stat-flooded-percent');
    const statFloodedArea = document.getElementById('stat-flooded-area');
    const statAffectedPopulation = document.getElementById('stat-affected-population');
    const statLowLying = document.getElementById('stat-low-lying');

    // Hover Panel Elements
    const hoverCoords = document.getElementById('hover-coords');
    const hoverElevation = document.getElementById('hover-elevation');
    const hoverStatus = document.getElementById('hover-status');

    // Scenario Selector Elements
    const scenarioOptions = document.querySelectorAll('.scenario-option');
    const effectiveSeaLevelContainer = document.getElementById('effective-sea-level-container');
    const effectiveSeaLevelVal = document.getElementById('effective-sea-level-val');
    const scenarioOffsetVal = document.getElementById('scenario-offset-val');

    // --- New Controls DOM Elements ---
    const enableDefensesToggle = document.getElementById('enable-defenses');
    const defenseDrawControls = document.getElementById('defense-draw-controls');
    const leveeHeightSlider = document.getElementById('levee-height-slider');
    const leveeHeightVal = document.getElementById('levee-height-val');
    const btnDrawLevee = document.getElementById('btn-draw-levee');
    const btnClearLevees = document.getElementById('btn-clear-levees');

    const scaleFactorSlider = document.getElementById('scale-factor-slider');
    const scaleFactorVal = document.getElementById('scale-factor-val');
    const offsetCorrectionSlider = document.getElementById('offset-correction-slider');
    const offsetCorrectionVal = document.getElementById('offset-correction-val');
    const decodingModeSelect = document.getElementById('decoding-mode-select');

    // Scientific equation displays
    const mslValDisplay = document.getElementById('msl-val');
    const tideOffsetValDisplay = document.getElementById('tide-offset-val');

    // --- Define Landmark Markers ---
    const landmarks = [
        // === 北部地區 (Northern Taiwan) ===
        {
            id: "taipei101",
            name: "台北 101 (Taipei 101)",
            lat: 25.033976,
            lon: 121.564537,
            elevation: 9,
            marker: null
        },
        {
            id: "luodong_park",
            name: "宜蘭羅東運動公園 (Luodong Park)",
            lat: 24.679116,
            lon: 121.753303,
            elevation: 8,
            marker: null
        },
        {
            id: "keelung_market",
            name: "基隆廟口夜市 (Keelung Market)",
            lat: 25.128400,
            lon: 121.744100,
            elevation: 3,
            marker: null
        },
        {
            id: "yehliu_queen",
            name: "野柳女王頭 (Queen's Head)",
            lat: 25.206400,
            lon: 121.691700,
            elevation: 5,
            marker: null
        },
        {
            id: "tamsui_fort",
            name: "淡水紅毛城 (Fort San Domingo)",
            lat: 25.175500,
            lon: 121.432800,
            elevation: 19,
            marker: null
        },
        {
            id: "songshan_airport",
            name: "台北松山機場 (Songshan Airport)",
            lat: 25.069700,
            lon: 121.551800,
            elevation: 5,
            marker: null
        },
        {
            id: "dadaocheng_wharf",
            name: "台北大稻埕碼頭 (Dadaocheng)",
            lat: 25.056900,
            lon: 121.507300,
            elevation: 4,
            marker: null
        },
        {
            id: "taoyuan_airport",
            name: "桃園國際機場 (Taoyuan Airport)",
            lat: 25.079700,
            lon: 121.234200,
            elevation: 33,
            marker: null
        },
        {
            id: "hsinchu_science",
            name: "新竹科學園區 (Hsinchu Park)",
            lat: 24.778100,
            lon: 121.014200,
            elevation: 75,
            marker: null
        },
        {
            id: "banqiao_station",
            name: "新北板橋車站 (Banqiao Station)",
            lat: 25.013000,
            lon: 121.463800,
            elevation: 9,
            marker: null
        },

        // === 中部地區 (Central Taiwan) ===
        {
            id: "taichung_city_hall",
            name: "台中市政府 (Taichung City Hall)",
            lat: 24.162442,
            lon: 120.647167,
            elevation: 65,
            marker: null
        },
        {
            id: "port_of_taichung",
            name: "台中港 (Port of Taichung)",
            lat: 24.256200,
            lon: 120.521700,
            elevation: 4,
            marker: null
        },
        {
            id: "gaomei_wetlands",
            name: "高美濕地 (Gaomei Wetlands)",
            lat: 24.311700,
            lon: 120.550100,
            elevation: 2,
            marker: null
        },
        {
            id: "national_theater",
            name: "台中國家歌劇院 (Opera House)",
            lat: 24.162700,
            lon: 120.640600,
            elevation: 62,
            marker: null
        },
        {
            id: "fengjia_market",
            name: "台中逢甲夜市 (Fengjia Market)",
            lat: 24.178700,
            lon: 120.646100,
            elevation: 82,
            marker: null
        },
        {
            id: "baguashan_buddha",
            name: "彰化八卦山大佛 (Great Buddha)",
            lat: 24.079300,
            lon: 120.550200,
            elevation: 97,
            marker: null
        },
        {
            id: "lukang_temple",
            name: "鹿港天后宮 (Lukang Temple)",
            lat: 24.058800,
            lon: 120.431200,
            elevation: 5,
            marker: null
        },
        {
            id: "sun_moon_lake",
            name: "日月潭玄奘寺 (Sun Moon Lake)",
            lat: 23.852700,
            lon: 120.913300,
            elevation: 752,
            marker: null
        },
        {
            id: "beigang_temple",
            name: "雲林北港朝天宮 (Beigang Temple)",
            lat: 23.568300,
            lon: 120.304800,
            elevation: 11,
            marker: null
        },
        {
            id: "longteng_bridge",
            name: "苗栗龍騰斷橋 (Longteng Bridge)",
            lat: 24.358400,
            lon: 120.776600,
            elevation: 350,
            marker: null
        },

        // === 南部地區 (Southern Taiwan) ===
        {
            id: "sky_tower_85",
            name: "高雄 85 大樓 (85 Sky Tower)",
            lat: 22.611634,
            lon: 120.300147,
            elevation: 6,
            marker: null
        },
        {
            id: "anping_fort",
            name: "台南安平古堡 (Anping Fort)",
            lat: 23.001556,
            lon: 120.160756,
            elevation: 4,
            marker: null
        },
        {
            id: "heel_church",
            name: "嘉義高跟鞋教堂 (Heel Church)",
            lat: 23.378300,
            lon: 120.149200,
            elevation: 2,
            marker: null
        },
        {
            id: "alishan_station",
            name: "嘉義阿里山車站 (Alishan Station)",
            lat: 23.511100,
            lon: 120.803300,
            elevation: 2216,
            marker: null
        },
        {
            id: "chihkan_tower",
            name: "台南赤崁樓 (Chihkan Tower)",
            lat: 22.997500,
            lon: 120.202800,
            elevation: 8,
            marker: null
        },
        {
            id: "chimei_museum",
            name: "台南奇美博物館 (Chimei Museum)",
            lat: 22.934700,
            lon: 120.226300,
            elevation: 12,
            marker: null
        },
        {
            id: "pier2_art",
            name: "高雄駁二藝術特區 (Pier-2)",
            lat: 22.620200,
            lon: 120.281600,
            elevation: 3,
            marker: null
        },
        {
            id: "formosa_station",
            name: "高雄美麗島捷運站 (Formosa)",
            lat: 22.631400,
            lon: 120.302000,
            elevation: 7,
            marker: null
        },
        {
            id: "dapeng_bay",
            name: "屏東大鵬灣風景區 (Dapeng Bay)",
            lat: 22.456700,
            lon: 120.478900,
            elevation: 2,
            marker: null
        },
        {
            id: "eluanbi_lighthouse",
            name: "屏東鵝鑾鼻燈塔 (Lighthouse)",
            lat: 21.902200,
            lon: 120.852600,
            elevation: 18,
            marker: null
        },

        // === 東部地區 (Eastern Taiwan) ===
        {
            id: "hualien_qixingtan",
            name: "花蓮七星潭 (Qixingtan Beach)",
            lat: 24.0306,
            lon: 121.6294,
            elevation: 4,
            marker: null
        },
        {
            id: "taitung_sanxiantai",
            name: "台東三仙台 (Sanxiantai)",
            lat: 23.1233,
            lon: 121.4114,
            elevation: 6,
            marker: null
        },
        {
            id: "hualien_taroko",
            name: "花蓮太魯閣牌樓 (Taroko Gorge Gate)",
            lat: 24.1568,
            lon: 121.6214,
            elevation: 60,
            marker: null
        },
        {
            id: "taitung_tiehua",
            name: "台東鐵花村 (Tiehua Village)",
            lat: 22.7519,
            lon: 121.1461,
            elevation: 15,
            marker: null
        },
        {
            id: "taitung_brown_ave",
            name: "台東伯朗大道 (Brown Avenue)",
            lat: 23.0975,
            lon: 121.2185,
            elevation: 260,
            marker: null
        },

        // === 自定義觀測點 (Custom Observation Points) ===
        {
            id: "custom_puli",
            name: "📍 南投埔里觀測點",
            lat: 23.9482,
            lon: 120.9880,
            elevation: 460,
            type: "user-custom",
            marker: null
        },
        {
            id: "custom_taoyuan",
            name: "📍 桃園忠一路觀測點",
            lat: 24.9926,
            lon: 121.3204,
            elevation: 110,
            type: "user-custom",
            marker: null
        },
        {
            id: "custom_fuxing",
            name: "📍 復興南路一段觀測點",
            lat: 25.0442,
            lon: 121.5438,
            elevation: 6,
            type: "user-custom",
            marker: null
        },
        {
            id: "custom_taichung",
            name: "📍 台中溫泉路觀測點",
            lat: 24.1147,
            lon: 120.6033,
            elevation: 190,
            type: "user-custom",
            marker: null
        },
        {
            id: "custom_hualien_yeba",
            name: "📍 花蓮葉霸豬腳觀測點",
            lat: 23.9775,
            lon: 121.5939,
            elevation: 15,
            type: "user-custom",
            marker: null
        }
    ];

    // === 中國省會與主要城市 (China Provinces & Municipalities) ===
    const chinaLandmarks = [
        { id: "china_beijing", name: "🇨🇳 北京市 (Beijing)", lat: 39.9042, lon: 116.4074, elevation: 44, marker: null },
        { id: "china_shanghai", name: "🇨🇳 上海市 (Shanghai)", lat: 31.2304, lon: 121.4737, elevation: 4, marker: null },
        { id: "china_tianjin", name: "🇨🇳 天津市 (Tianjin)", lat: 39.0842, lon: 117.2008, elevation: 3, marker: null },
        { id: "china_chongqing", name: "🇨🇳 重慶市 (Chongqing)", lat: 29.5630, lon: 106.5516, elevation: 244, marker: null },
        { id: "china_guangdong", name: "🇨🇳 廣東省 (Guangzhou)", lat: 23.1291, lon: 113.2644, elevation: 11, marker: null },
        { id: "china_zhejiang", name: "🇨🇳 浙江省 (Hangzhou)", lat: 30.2741, lon: 120.1551, elevation: 19, marker: null },
        { id: "china_jiangsu", name: "🇨🇳 江蘇省 (Nanjing)", lat: 32.0603, lon: 118.7969, elevation: 20, marker: null },
        { id: "china_fujian", name: "🇨🇳 福建省 (Fuzhou)", lat: 26.0745, lon: 119.2965, elevation: 14, marker: null },
        { id: "china_shandong", name: "🇨🇳 山東省 (Jinan)", lat: 36.6512, lon: 117.1201, elevation: 32, marker: null },
        { id: "china_liaoning", name: "🇨🇳 遼寧省 (Shenyang)", lat: 41.8057, lon: 123.4315, elevation: 41, marker: null },
        { id: "china_hebei", name: "🇨🇳 河北省 (Shijiazhuang)", lat: 38.0428, lon: 114.5149, elevation: 81, marker: null },
        { id: "china_henan", name: "🇨🇳 河南省 (Zhengzhou)", lat: 34.7579, lon: 113.6654, elevation: 108, marker: null },
        { id: "china_hubei", name: "🇨🇳 湖北省 (Wuhan)", lat: 30.5928, lon: 114.3055, elevation: 27, marker: null },
        { id: "china_hunan", name: "🇨🇳 湖南省 (Changsha)", lat: 28.2282, lon: 112.9388, elevation: 44, marker: null },
        { id: "china_jiangxi", name: "🇨🇳 江西省 (Nanchang)", lat: 28.6833, lon: 115.8575, elevation: 29, marker: null },
        { id: "china_anhui", name: "🇨🇳 安徽省 (Hefei)", lat: 31.8206, lon: 117.2272, elevation: 29, marker: null },
        { id: "china_sichuan", name: "🇨🇳 四川省 (Chengdu)", lat: 30.5728, lon: 104.0665, elevation: 500, marker: null },
        { id: "china_guizhou", name: "🇨🇳 貴州省 (Guiyang)", lat: 26.5982, lon: 106.7072, elevation: 1100, marker: null },
        { id: "china_yunnan", name: "🇨🇳 雲南省 (Kunming)", lat: 25.0422, lon: 102.7122, elevation: 1890, marker: null },
        { id: "china_shaanxi", name: "🇨🇳 陝西省 (Xi'an)", lat: 34.3416, lon: 108.9398, elevation: 405, marker: null },
        { id: "china_gansu", name: "🇨🇳 甘肅省 (Lanzhou)", lat: 36.0611, lon: 103.8343, elevation: 1518, marker: null },
        { id: "china_qinghai", name: "🇨🇳 青海省 (Xining)", lat: 36.6171, lon: 101.7785, elevation: 2261, marker: null },
        { id: "china_hainan", name: "🇨🇳 海南省 (Haikou)", lat: 20.0174, lon: 110.3492, elevation: 8, marker: null },
        { id: "china_shanxi", name: "🇨🇳 山西省 (Taiyuan)", lat: 37.8735, lon: 112.5624, elevation: 800, marker: null },
        { id: "china_jilin", name: "🇨🇳 吉林省 (Changchun)", lat: 43.8171, lon: 125.3235, elevation: 222, marker: null },
        { id: "china_heilongjiang", name: "🇨🇳 黑龍江省 (Harbin)", lat: 45.8038, lon: 126.5350, elevation: 150, marker: null },
        { id: "china_neimenggu", name: "🇨🇳 內蒙古自治區 (Hohhot)", lat: 40.8415, lon: 111.7511, elevation: 1050, marker: null },
        { id: "china_guangxi", name: "🇨🇳 廣西壯族自治區 (Nanning)", lat: 22.8170, lon: 108.3665, elevation: 75, marker: null },
        { id: "china_xizang", name: "🇨🇳 西藏自治區 (Lhasa)", lat: 29.6524, lon: 91.1172, elevation: 3656, marker: null },
        { id: "china_ningxia", name: "🇨🇳 寧夏回族自治區 (Yinchuan)", lat: 38.4872, lon: 106.2309, elevation: 1110, marker: null },
        { id: "china_xinjiang", name: "🇨🇳 新疆維吾爾自治區 (Urumqi)", lat: 43.8256, lon: 87.6168, elevation: 800, marker: null },
        { id: "china_hongkong", name: "🇭🇰 香港特別行政區 (Hong Kong)", lat: 22.3193, lon: 114.1694, elevation: 5, marker: null },
        { id: "china_macau", name: "🇲🇴 澳門特別行政區 (Macau)", lat: 22.1987, lon: 113.5439, elevation: 3, marker: null }
    ];

    // === 世界重要城市與各國首都 (World Major Cities & Capitals) ===
    const worldLandmarks = [
        // --- 亞洲 (Asia) ---
        { id: "world_tokyo", name: "🇯🇵 東京 (Tokyo, Japan)", lat: 35.6762, lon: 139.6503, elevation: 6, marker: null },
        { id: "world_seoul", name: "🇰🇷 首爾 (Seoul, South Korea)", lat: 37.5665, lon: 126.9780, elevation: 33, marker: null },
        { id: "world_pyongyang", name: "🇰🇵 平壤 (Pyongyang, North Korea)", lat: 39.0392, lon: 125.7625, elevation: 27, marker: null },
        { id: "world_ulaanbaatar", name: "🇲🇳 烏蘭巴托 (Ulaanbaatar, Mongolia)", lat: 47.8864, lon: 106.9057, elevation: 1350, marker: null },
        { id: "world_bangkok", name: "🇹🇭 曼谷 (Bangkok, Thailand)", lat: 13.7563, lon: 100.5018, elevation: 1.5, marker: null },
        { id: "world_singapore", name: "🇸🇬 新加坡 (Singapore)", lat: 1.3521, lon: 103.8198, elevation: 5, marker: null },
        { id: "world_jakarta", name: "🇮🇩 雅加達 (Jakarta, Indonesia)", lat: -6.2088, lon: 106.8456, elevation: 8, marker: null },
        { id: "world_manila", name: "🇵🇭 馬尼拉 (Manila, Philippines)", lat: 14.5995, lon: 120.9842, elevation: 16, marker: null },
        { id: "world_hanoi", name: "🇻🇳 河內 (Hanoi, Vietnam)", lat: 21.0285, lon: 105.8542, elevation: 19, marker: null },
        { id: "world_kualalumpur", name: "🇲🇾 吉隆坡 (Kuala Lumpur, Malaysia)", lat: 3.1390, lon: 101.6869, elevation: 66, marker: null },
        { id: "world_phnompenh", name: "🇰🇭 金邊 (Phnom Penh, Cambodia)", lat: 11.5564, lon: 104.9282, elevation: 12, marker: null },
        { id: "world_vientiane", name: "🇱🇦 永珍 (Vientiane, Laos)", lat: 17.9757, lon: 102.6331, elevation: 174, marker: null },
        { id: "world_naypyidaw", name: "🇲🇲 奈比多 (Naypyidaw, Myanmar)", lat: 19.7633, lon: 96.0785, elevation: 115, marker: null },
        { id: "world_dili", name: "🇹🇱 帝利 (Dili, East Timor)", lat: -8.5568, lon: 125.5603, elevation: 3, marker: null },
        { id: "world_bandarseri", name: "🇧🇳 斯里巴加灣 (Bandar Seri Begawan, Brunei)", lat: 4.8903, lon: 114.9404, elevation: 15, marker: null },
        
        { id: "world_newdelhi", name: "🇮🇳 新德里 (New Delhi, India)", lat: 28.6139, lon: 77.2090, elevation: 216, marker: null },
        { id: "world_mumbai", name: "🇮🇳 孟買 (Mumbai, India)", lat: 19.0760, lon: 72.8777, elevation: 14, marker: null },
        { id: "world_kolkata", name: "🇮🇳 加爾各答 (Kolkata, India)", lat: 22.5726, lon: 88.3639, elevation: 9, marker: null },
        { id: "world_dhaka", name: "🇧🇩 達卡 (Dhaka, Bangladesh)", lat: 23.8103, lon: 90.4125, elevation: 4, marker: null },
        { id: "world_islamabad", name: "🇵🇰 伊斯蘭馬巴德 (Islamabad, Pakistan)", lat: 33.6844, lon: 73.0479, elevation: 540, marker: null },
        { id: "world_karachi", name: "🇵🇰 卡拉奇 (Karachi, Pakistan)", lat: 24.8607, lon: 67.0011, elevation: 10, marker: null },
        { id: "world_kabul", name: "🇦🇫 喀布爾 (Kabul, Afghanistan)", lat: 34.5553, lon: 69.1772, elevation: 1790, marker: null },
        { id: "world_kathmandu", name: "🇳🇵 加德滿都 (Kathmandu, Nepal)", lat: 27.7172, lon: 85.3240, elevation: 1400, marker: null },
        { id: "world_colombo", name: "🇱🇰 哥倫坡 (Colombo, Sri Lanka)", lat: 6.9271, lon: 79.8612, elevation: 5, marker: null },
        { id: "world_male", name: "🇲🇻 馬累 (Malé, Maldives)", lat: 4.1755, lon: 73.5093, elevation: 1.5, marker: null },
        
        { id: "world_astana", name: "🇰🇿 阿斯塔納 (Astana, Kazakhstan)", lat: 51.1694, lon: 71.4491, elevation: 347, marker: null },
        { id: "world_tashkent", name: "🇺🇿 塔什干 (Tashkent, Uzbekistan)", lat: 41.2995, lon: 69.2401, elevation: 457, marker: null },
        { id: "world_bishkek", name: "🇰🇬 比什凱克 (Bishkek, Kyrgyzstan)", lat: 42.8746, lon: 74.5698, elevation: 800, marker: null },
        { id: "world_dushanbe", name: "🇹🇯 杜尚貝 (Dushanbe, Tajikistan)", lat: 38.5598, lon: 68.7870, elevation: 706, marker: null },
        { id: "world_ashgabat", name: "🇹🇲 阿什哈巴德 (Ashgabat, Turkmenistan)", lat: 37.9601, lon: 58.3260, elevation: 219, marker: null },

        { id: "world_tehran", name: "🇮🇷 德黑蘭 (Tehran, Iran)", lat: 35.6892, lon: 51.3890, elevation: 1200, marker: null },
        { id: "world_baghdad", name: "🇮🇶 巴格達 (Baghdad, Iraq)", lat: 33.3128, lon: 44.3615, elevation: 34, marker: null },
        { id: "world_riyadh", name: "🇸🇦 利雅德 (Riyadh, Saudi Arabia)", lat: 24.7136, lon: 46.6753, elevation: 612, marker: null },
        { id: "world_jeddah", name: "🇸🇦 吉達 (Jeddah, Saudi Arabia)", lat: 21.5433, lon: 39.1728, elevation: 12, marker: null },
        { id: "world_abu_dhabi", name: "🇦🇪 阿布達比 (Abu Dhabi, UAE)", lat: 24.4539, lon: 54.3773, elevation: 5, marker: null },
        { id: "world_dubai", name: "🇦🇪 杜拜 (Dubai, UAE)", lat: 25.2048, lon: 55.2708, elevation: 0, marker: null },
        { id: "world_doha", name: "🇶🇦 杜哈 (Doha, Qatar)", lat: 25.2854, lon: 51.5310, elevation: 10, marker: null },
        { id: "world_manama", name: "🇧🇭 麥納麥 (Manama, Bahrain)", lat: 26.2285, lon: 50.5860, elevation: 2, marker: null },
        { id: "world_muscat", name: "🇴🇲 馬斯喀特 (Muscat, Oman)", lat: 23.5859, lon: 58.4059, elevation: 68, marker: null },
        { id: "world_sanaa", name: "🇾🇪 薩那 (Sanaa, Yemen)", lat: 15.3694, lon: 44.1910, elevation: 2250, marker: null },
        { id: "world_damascus", name: "🇸🇾 大馬士革 (Damascus, Syria)", lat: 33.5138, lon: 36.2765, elevation: 680, marker: null },
        { id: "world_beirut", name: "🇱🇧 貝魯特 (Beirut, Lebanon)", lat: 33.8938, lon: 35.5018, elevation: 0, marker: null },
        { id: "world_amman", name: "🇯🇴 安曼 (Amman, Jordan)", lat: 31.9454, lon: 35.9284, elevation: 800, marker: null },
        { id: "world_jerusalem", name: "🇮🇱 耶路撒冷 (Jerusalem, Israel)", lat: 31.7683, lon: 35.2137, elevation: 754, marker: null },
        { id: "world_telaviv", name: "🇮🇱 特拉維夫 (Tel Aviv, Israel)", lat: 32.0853, lon: 34.7818, elevation: 5, marker: null },
        { id: "world_ankara", name: "🇹🇷 安卡拉 (Ankara, Turkey)", lat: 39.9334, lon: 32.8597, elevation: 938, marker: null },
        { id: "world_istanbul", name: "🇹🇷 伊斯坦堡 (Istanbul, Turkey)", lat: 41.0082, lon: 28.9784, elevation: 30, marker: null },

        // --- 歐洲 (Europe) ---
        { id: "world_london", name: "🇬🇧 倫敦 (London, UK)", lat: 51.5074, lon: -0.1278, elevation: 11, marker: null },
        { id: "world_edinburgh", name: "🇬🇧 愛丁堡 (Edinburgh, UK)", lat: 55.9533, lon: -3.1883, elevation: 47, marker: null },
        { id: "world_paris", name: "🇫🇷 巴黎 (Paris, France)", lat: 48.8566, lon: 2.3522, elevation: 35, marker: null },
        { id: "world_marseille", name: "🇫🇷 馬賽 (Marseille, France)", lat: 43.2965, lon: 5.3698, elevation: 12, marker: null },
        { id: "world_berlin", name: "🇩🇪 柏林 (Berlin, Germany)", lat: 52.5200, lon: 13.4050, elevation: 34, marker: null },
        { id: "world_hamburg", name: "🇩🇪 漢堡 (Hamburg, Germany)", lat: 53.5511, lon: 9.9937, elevation: 6, marker: null },
        { id: "world_rome", name: "🇮🇹 羅馬 (Rome, Italy)", lat: 41.9028, lon: 12.4964, elevation: 21, marker: null },
        { id: "world_venice", name: "🇮🇹 威尼斯 (Venice, Italy)", lat: 45.4340, lon: 12.3388, elevation: 1, marker: null },
        { id: "world_madrid", name: "🇪🇸 馬德里 (Madrid, Spain)", lat: 40.4168, lon: -3.7038, elevation: 667, marker: null },
        { id: "world_barcelona", name: "🇪🇸 巴塞隆納 (Barcelona, Spain)", lat: 41.3851, lon: 2.1734, elevation: 12, marker: null },
        { id: "world_lisbon", name: "🇵🇹 里斯本 (Lisbon, Portugal)", lat: 38.7223, lon: -9.1393, elevation: 15, marker: null },
        { id: "world_brussels", name: "🇧🇪 布魯塞爾 (Brussels, Belgium)", lat: 50.8503, lon: 4.3517, elevation: 13, marker: null },
        { id: "world_amsterdam", name: "🇳🇱 阿姆斯特丹 (Amsterdam, Netherlands)", lat: 52.3676, lon: 4.9041, elevation: -2, marker: null },
        { id: "world_rotterdam", name: "🇳🇱 鹿特丹 (Rotterdam, Netherlands)", lat: 51.9244, lon: 4.4777, elevation: -2, marker: null },
        { id: "world_bern", name: "🇨🇭 伯恩 (Bern, Switzerland)", lat: 46.9480, lon: 7.4474, elevation: 542, marker: null },
        { id: "world_geneva", name: "🇨🇭 日內瓦 (Geneva, Switzerland)", lat: 46.2044, lon: 6.1432, elevation: 375, marker: null },
        { id: "world_vienna", name: "🇦🇹 維也納 (Vienna, Austria)", lat: 48.2082, lon: 16.3738, elevation: 186, marker: null },
        { id: "world_athens", name: "🇬🇷 雅典 (Athens, Greece)", lat: 37.9838, lon: 23.7275, elevation: 20, marker: null },
        { id: "world_copenhagen", name: "🇩🇰 哥本哈根 (Copenhagen, Denmark)", lat: 55.6761, lon: 12.5683, elevation: 5, marker: null },
        { id: "world_oslo", name: "🇳🇴 奧斯陸 (Oslo, Norway)", lat: 59.9139, lon: 10.7522, elevation: 23, marker: null },
        { id: "world_stockholm", name: "🇸🇪 斯德哥爾摩 (Stockholm, Sweden)", lat: 59.3293, lon: 18.0686, elevation: 15, marker: null },
        { id: "world_helsinki", name: "🇫🇮 赫爾辛基 (Helsinki, Finland)", lat: 60.1699, lon: 24.9384, elevation: 17, marker: null },
        { id: "world_moscow", name: "🇷🇺 莫斯科 (Moscow, Russia)", lat: 55.7558, lon: 37.6173, elevation: 156, marker: null },
        { id: "world_st_petersburg", name: "🇷🇺 聖彼得堡 (St. Petersburg, Russia)", lat: 59.9343, lon: 30.3351, elevation: 3, marker: null },
        { id: "world_vladivostok", name: "🇷🇺 海參崴 (Vladivostok, Russia)", lat: 43.1198, lon: 131.8869, elevation: 8, marker: null },
        { id: "world_yekaterinburg", name: "🇷🇺 葉卡捷琳堡 (Yekaterinburg, Russia)", lat: 56.8389, lon: 60.6057, elevation: 273, marker: null },
        { id: "world_kyiv", name: "🇺🇦 基輔 (Kyiv, Ukraine)", lat: 50.4501, lon: 30.5234, elevation: 179, marker: null },
        { id: "world_warsaw", name: "🇵🇱 華沙 (Warsaw, Poland)", lat: 52.2297, lon: 21.0122, elevation: 100, marker: null },
        { id: "world_prague", name: "🇨🇿 布拉格 (Prague, Czech Republic)", lat: 50.0755, lon: 14.4378, elevation: 244, marker: null },
        { id: "world_budapest", name: "🇭🇺 布達佩斯 (Budapest, Hungary)", lat: 47.4979, lon: 19.0402, elevation: 102, marker: null },
        { id: "world_dublin", name: "🇮🇪 都柏林 (Dublin, Ireland)", lat: 53.3498, lon: -6.2603, elevation: 20, marker: null },
        { id: "world_reykjavik", name: "🇮🇸 雷克雅維克 (Reykjavik, Iceland)", lat: 64.1466, lon: -21.9426, elevation: 8, marker: null },

        // --- 北美洲 (North America) ---
        { id: "world_washington", name: "🇺🇸 華盛頓 (Washington D.C., USA)", lat: 38.9072, lon: -77.0369, elevation: 7, marker: null },
        { id: "world_newyork", name: "🇺🇸 紐約 (New York, USA)", lat: 40.7128, lon: -74.0060, elevation: 10, marker: null },
        { id: "world_losangeles", name: "🇺🇸 洛杉磯 (Los Angeles, USA)", lat: 34.0522, lon: -118.2437, elevation: 71, marker: null },
        { id: "world_sanfrancisco", name: "🇺🇸 三藩市 (San Francisco, USA)", lat: 37.7749, lon: -122.4194, elevation: 16, marker: null },
        { id: "world_miami", name: "🇺🇸 邁阿密 (Miami, USA)", lat: 25.7617, lon: -80.1918, elevation: 2, marker: null },
        { id: "world_neworleans", name: "🇺🇸 新奧爾良 (New Orleans, USA)", lat: 29.9511, lon: -90.0715, elevation: -1, marker: null },
        { id: "world_chicago", name: "🇺🇸 芝加哥 (Chicago, USA)", lat: 41.8781, lon: -87.6298, elevation: 182, marker: null },
        { id: "world_ottawa", name: "🇨🇦 渥太華 (Ottawa, Canada)", lat: 45.4215, lon: -75.6972, elevation: 70, marker: null },
        { id: "world_toronto", name: "🇨🇦 多倫多 (Toronto, Canada)", lat: 43.6532, lon: -79.3832, elevation: 76, marker: null },
        { id: "world_vancouver", name: "🇨🇦 溫哥華 (Vancouver, Canada)", lat: 49.2827, lon: -123.1207, elevation: 4, marker: null },
        { id: "world_montreal", name: "🇨🇦 蒙特婁 (Montreal, Canada)", lat: 45.5017, lon: -73.5673, elevation: 30, marker: null },
        { id: "world_mexicocity", name: "🇲🇽 墨西哥城 (Mexico City, Mexico)", lat: 19.4326, lon: -99.1332, elevation: 2240, marker: null },
        { id: "world_cancun", name: "🇲🇽 坎昆 (Cancún, Mexico)", lat: 21.1619, lon: -86.8515, elevation: 5, marker: null },
        { id: "world_havana", name: "🇨🇺 哈瓦那 (Havana, Cuba)", lat: 23.1136, lon: -82.3666, elevation: 24, marker: null },
        { id: "world_nassau", name: "🇧🇸 拿索 (Nassau, Bahamas)", lat: 25.0475, lon: -77.3554, elevation: 2, marker: null },

        // --- 中美洲與加勒比海 (Central America & Caribbean) ---
        { id: "world_guatemalacity", name: "🇬🇹 瓜地馬拉市 (Guatemala City, Guatemala)", lat: 14.6349, lon: -90.5069, elevation: 1500, marker: null },
        { id: "world_sanjose", name: "🇨🇷 聖荷西 (San José, Costa Rica)", lat: 9.9281, lon: -84.0907, elevation: 1170, marker: null },
        { id: "world_panamacity", name: "🇵🇦 巴拿馬城 (Panama City, Panama)", lat: 8.9824, lon: -79.5199, elevation: 0, marker: null },

        // --- 南美洲 (South America) ---
        { id: "world_brasilia", name: "🇧🇷 巴西利亞 (Brasilia, Brazil)", lat: -15.7938, lon: -47.8828, elevation: 1172, marker: null },
        { id: "world_rio", name: "🇧🇷 里約熱內盧 (Rio de Janeiro, Brazil)", lat: -22.9068, lon: -43.1729, elevation: 5, marker: null },
        { id: "world_saopaulo", name: "🇧🇷 聖保羅 (São Paulo, Brazil)", lat: -23.5505, lon: -46.6333, elevation: 760, marker: null },
        { id: "world_buenosaires", name: "🇦🇷 布宜諾斯艾利斯 (Buenos Aires, Argentina)", lat: -34.6037, lon: -58.3816, elevation: 25, marker: null },
        { id: "world_santiago", name: "🇨🇱 聖地牙哥 (Santiago, Chile)", lat: -33.4489, lon: -70.6693, elevation: 570, marker: null },
        { id: "world_bogota", name: "🇨🇴 波哥大 (Bogota, Colombia)", lat: 4.7110, lon: -74.0721, elevation: 2640, marker: null },
        { id: "world_caracas", name: "🇻🇪 卡拉卡斯 (Caracas, Venezuela)", lat: 10.4806, lon: -66.9036, elevation: 900, marker: null },
        { id: "world_lima", name: "🇵🇪 利馬 (Lima, Peru)", lat: -12.0464, lon: -77.0428, elevation: 154, marker: null },
        { id: "world_quito", name: "🇪🇨 基多 (Quito, Ecuador)", lat: -0.1807, lon: -78.4678, elevation: 2850, marker: null },
        { id: "world_montevideo", name: "🇺🇾 蒙特維多 (Montevideo, Uruguay)", lat: -34.9011, lon: -56.1645, elevation: 43, marker: null },
        { id: "world_asuncion", name: "🇵🇾 亞松森 (Asunción, Paraguay)", lat: -25.2637, lon: -57.5759, elevation: 43, marker: null },
        { id: "world_lapaz", name: "🇧🇴 拉巴斯 (La Paz, Bolivia)", lat: -16.4897, lon: -68.1193, elevation: 3640, marker: null },

        // --- 大洋洲 (Oceania) ---
        { id: "world_canberra", name: "🇦🇺 坎培拉 (Canberra, Australia)", lat: -35.2809, lon: 149.1300, elevation: 578, marker: null },
        { id: "world_sydney", name: "🇦🇺 雪梨 (Sydney, Australia)", lat: -33.8688, lon: 151.2093, elevation: 19, marker: null },
        { id: "world_melbourne", name: "🇦🇺 墨爾本 (Melbourne, Australia)", lat: -37.8136, lon: 144.9631, elevation: 31, marker: null },
        { id: "world_brisbane", name: "🇦🇺 布里斯本 (Brisbane, Australia)", lat: -27.4705, lon: 153.0260, elevation: 28, marker: null },
        { id: "world_darwin", name: "🇦🇺 達爾文 (Darwin, Australia)", lat: -12.4634, lon: 130.8456, elevation: 31, marker: null },
        { id: "world_perth", name: "🇦🇺 伯斯 (Perth, Australia)", lat: -31.9505, lon: 115.8605, elevation: 38, marker: null },
        { id: "world_wellington", name: "🇳🇿 威靈頓 (Wellington, New Zealand)", lat: -41.2865, lon: 174.7762, elevation: 20, marker: null },
        { id: "world_auckland", name: "🇳🇿 奧克蘭 (Auckland, New Zealand)", lat: -36.8485, lon: 174.7633, elevation: 10, marker: null },
        { id: "world_suva", name: "🇫🇯 蘇瓦 (Suva, Fiji)", lat: -18.1248, lon: 178.4501, elevation: 20, marker: null },
        { id: "world_apia", name: "🇼🇸 阿庇亞 (Apia, Samoa)", lat: -13.8333, lon: -171.7667, elevation: 2, marker: null },
        { id: "world_nukualofa", name: "🇹🇴 努瓜婁發 (Nuku'alofa, Tonga)", lat: -21.1395, lon: -175.2018, elevation: 3, marker: null },

        // --- 非洲 (Africa) ---
        { id: "world_cairo", name: "🇪🇬 開羅 (Cairo, Egypt)", lat: 30.0444, lon: 31.2357, elevation: 23, marker: null },
        { id: "world_alexandria", name: "🇪🇬 亞歷山大 (Alexandria, Egypt)", lat: 31.2001, lon: 29.9187, elevation: -1, marker: null },
        { id: "world_pretoria", name: "🇿🇦 普利托利亞 (Pretoria, South Africa)", lat: -25.7479, lon: 28.2293, elevation: 1339, marker: null },
        { id: "world_capetown", name: "🇿🇦 開普敦 (Cape Town, South Africa)", lat: -33.9249, lon: 18.4241, elevation: 25, marker: null },
        { id: "world_durban", name: "🇿🇦 德班 (Durban, South Africa)", lat: -29.8587, lon: 31.0218, elevation: 10, marker: null },
        { id: "world_nairobi", name: "🇰🇪 奈洛比 (Nairobi, Kenya)", lat: -1.2921, lon: 36.8219, elevation: 1795, marker: null },
        { id: "world_abuja", name: "🇳🇬 阿布加 (Abuja, Nigeria)", lat: 9.0765, lon: 7.3986, elevation: 360, marker: null },
        { id: "world_lagos", name: "🇳🇬 拉哥斯 (Lagos, Nigeria)", lat: 6.5244, lon: 3.3792, elevation: 6, marker: null },
        { id: "world_dakar", name: "🇸🇳 達卡 (Dakar, Senegal)", lat: 14.7167, lon: -17.4677, elevation: 22, marker: null },
        { id: "world_accra", name: "🇬🇭 阿克拉 (Accra, Ghana)", lat: 5.6037, lon: -0.1870, elevation: 61, marker: null },
        { id: "world_addisababa", name: "🇪🇹 亞的斯亞貝巴 (Addis Ababa, Ethiopia)", lat: 9.0300, lon: 38.7400, elevation: 2355, marker: null },
        { id: "world_mogadishu", name: "🇸🇴 摩加迪沙 (Mogadishu, Somalia)", lat: 2.0469, lon: 45.3182, elevation: 9, marker: null },
        { id: "world_tunis", name: "🇹🇳 突尼斯 (Tunis, Tunisia)", lat: 36.8065, lon: 10.1815, elevation: 4, marker: null },
        { id: "world_rabat", name: "🇲🇦 拉巴特 (Rabat, Morocco)", lat: 34.0209, lon: -6.8417, elevation: 51, marker: null },
        { id: "world_casablanca", name: "🇲🇦 卡薩布蘭卡 (Casablanca, Morocco)", lat: 33.5731, lon: -7.5898, elevation: 13, marker: null },
        { id: "world_luanda", name: "🇦🇴 盧安達 (Luanda, Angola)", lat: -8.8390, lon: 13.2894, elevation: 6, marker: null }
    ];

    // --- Population Distribution Model ---
    // Total population = 23.5 Million
    // We model the population residing within different elevation brackets in Taiwan
    const populationModel = [
        { min: 0, max: 2, pop: 1500000 },    // 1.5M in extremely low coastal areas
        { min: 2, max: 5, pop: 3000000 },    // 3.0M in low coastal areas
        { min: 5, max: 10, pop: 5000000 },   // 5.0M in low plains/basins (major parts of Taipei, Yilan, Tainan)
        { min: 10, max: 20, pop: 6000000 },  // 6.0M in plains/basins (Taipei, New Taipei, Kaohsiung)
        { min: 20, max: 50, pop: 4500000 },  // 4.5M in terraced plains/hills (Taichung, Taoyuan)
        { min: 50, max: 100, pop: 2000000 }, // 2.0M in high terraces/slopes
        { min: 100, max: 200, pop: 1000000 },// 1.0M in foothills
        { min: 200, max: 4000, pop: 500000 } // 0.5M in mountain areas
    ];

    // --- Key Regions Bounding Boxes & Statistics ---
    const regions = [
        {
            id: 'taipei',
            name: '台北盆地 (Taipei Basin)',
            bounds: { south: 24.95, north: 25.15, west: 121.40, east: 121.65 },
            pxBounds: null,
            totalLandPixels: 0,
            floodedPixels: 0
        },
        {
            id: 'yilan',
            name: '宜蘭平原 (Yilan Plain)',
            bounds: { south: 24.60, north: 24.88, west: 121.65, east: 121.88 },
            pxBounds: null,
            totalLandPixels: 0,
            floodedPixels: 0
        },
        {
            id: 'chianan',
            name: '嘉南平原 (Chianan Plain)',
            bounds: { south: 22.90, north: 23.70, west: 120.00, east: 120.45 },
            pxBounds: null,
            totalLandPixels: 0,
            floodedPixels: 0
        },
        {
            id: 'kaohsiung',
            name: '高雄沿海 (Kaohsiung Coast)',
            bounds: { south: 22.45, north: 22.82, west: 120.15, east: 120.45 },
            pxBounds: null,
            totalLandPixels: 0,
            floodedPixels: 0
        },
        {
            id: 'huadong',
            name: '花東沿海 (Huadong Coast)',
            bounds: { south: 22.30, north: 24.20, west: 121.10, east: 121.65 },
            pxBounds: null,
            totalLandPixels: 0,
            floodedPixels: 0
        }
    ];

    // Calculate pixel bounds for each region based on geographic coordinates
    function initRegionPixelBounds() {
        const eb = state.elevationBounds;
        if (!eb) return;

        regions.forEach(reg => {
            const minX = Math.max(0, Math.floor(((reg.bounds.west - eb.west) / (eb.east - eb.west)) * state.imgWidth));
            const maxX = Math.min(state.imgWidth - 1, Math.floor(((reg.bounds.east - eb.west) / (eb.east - eb.west)) * state.imgWidth));
            
            // Latitude: North is top (y=0), South is bottom (y=height)
            const minY = Math.max(0, Math.floor(((eb.north - reg.bounds.north) / (eb.north - eb.south)) * state.imgHeight));
            const maxY = Math.min(state.imgHeight - 1, Math.floor(((eb.north - reg.bounds.south) / (eb.north - eb.south)) * state.imgHeight));

            reg.pxBounds = { minX, maxX, minY, maxY };
        });
    }

    // --- Initialize Leaflet Map ---
    const map = L.map('map', {
        center: [23.7, 121.0], // Center of Taiwan
        zoom: 4,               // Zoom out to show East Asia and the world
        minZoom: 2,
        maxZoom: 18,
        zoomControl: true
    });

    // Dark styled basemap (CartoDB Dark Matter)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 20
    }).addTo(map);

    // Initialize layer groups for landmarks
    const taiwanLayer = L.markerClusterGroup({
        spiderfyOnMaxZoom: true,
        showCoverageOnHover: false,
        zoomToBoundsOnClick: true,
        maxClusterRadius: 40
    }).addTo(map);
    const chinaLayer = L.featureGroup().addTo(map);
    const worldLayer = L.featureGroup().addTo(map);

    // Add styled layer control in the top-right corner
    const overlayMaps = {
        "台灣觀測點": taiwanLayer,
        "中國省會": chinaLayer,
        "世界城市": worldLayer
    };
    L.control.layers(null, overlayMaps, { collapsed: false }).addTo(map);

    // Initialize custom markers for landmarks
    initLandmarks();

    // Listen to zoom changes to show/hide labels in bulk (avoid clutter at low zoom)
    function updateLabelZoomState() {
        const zoom = map.getZoom();
        const mapEl = document.getElementById('map');
        if (zoom >= 9) {
            mapEl.classList.add('show-all-labels');
        } else {
            mapEl.classList.remove('show-all-labels');
        }
    }
    map.on('zoomend', updateLabelZoomState);
    updateLabelZoomState(); // Run once initially

    // Canvas overlay reference
    let canvasOverlay = null;

    // Offscreen canvases for processing
    const elevationCanvas = document.createElement('canvas');
    const elevationCtx = elevationCanvas.getContext('2d');

    const waterCanvas = document.createElement('canvas');
    const waterCtx = waterCanvas.getContext('2d');

    // --- Load Elevation Data & Metadata from Inline Asset ---
    if (typeof TAIWAN_DATA !== 'undefined') {
        state.elevationBounds = TAIWAN_DATA.bounds;

        loadImage(TAIWAN_DATA.elevationImage).then(img => {
            // Optimize resolution for high performance (downsample if image is too large)
            const targetWidth = 640;
            const scaleFactor = targetWidth / img.width;
            const targetHeight = Math.round(img.height * scaleFactor);

            state.imgWidth = targetWidth;
            state.imgHeight = targetHeight;

            elevationCanvas.width = targetWidth;
            elevationCanvas.height = targetHeight;
            waterCanvas.width = targetWidth;
            waterCanvas.height = targetHeight;

            // Draw image onto offscreen canvas
            elevationCtx.drawImage(img, 0, 0, targetWidth, targetHeight);

            // Extract pixel data
            const imgData = elevationCtx.getImageData(0, 0, targetWidth, targetHeight);
            state.elevationData = imgData.data;

            // Initialize regional pixel bounds mapping
            initRegionPixelBounds();

            // Build Elevation Histogram & count land pixels
            buildHistogram();

            // Try to load pre-loaded constraint mask (non-blocking)
            loadConstraintMask().then(() => {
                state.dataLoaded = true;

                // Add the Canvas Overlay to the map
                setupCanvasOverlay();

                // Initial render
                updateFlooding();
            });
        }).catch(err => {
            console.error("Failed to load elevation image:", err);
            alert("無法載入地形高程影像，請確認 assets/taiwan_data.js 資料正確。");
        });
    } else {
        console.error("TAIWAN_DATA is not defined. Make sure assets/taiwan_data.js is loaded.");
        alert("找不到高程資料，請確保已載入 assets/taiwan_data.js。");
    }

    // Helper to load image as Promise
    function loadImage(src) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = src;
        });
    }

    // Try to load pre-loaded constraint mask (non-blocking)
    function loadConstraintMask() {
        return new Promise((resolve) => {
            const maskSrc = 'assets/taiwan_mask.png';
            loadImage(maskSrc).then(maskImg => {
                console.log("Found pre-loaded constraint mask layer. Loading...");
                
                const maskCanvas = document.createElement('canvas');
                maskCanvas.width = state.imgWidth;
                maskCanvas.height = state.imgHeight;
                const maskCtx = maskCanvas.getContext('2d');
                
                // Draw mask onto canvas with matching resolution
                maskCtx.drawImage(maskImg, 0, 0, state.imgWidth, state.imgHeight);
                
                const imgData = maskCtx.getImageData(0, 0, state.imgWidth, state.imgHeight);
                const data = imgData.data;
                
                state.constraintMask = new Uint8Array(state.imgWidth * state.imgHeight);
                
                // Set constraint mask: 1 if active (non-transparent or red channel > 128)
                for (let i = 0; i < state.imgWidth * state.imgHeight; i++) {
                    const idx = i * 4;
                    // If pixel is non-transparent (Alpha > 50) and has red channel active, treat as barrier
                    if (data[idx + 3] > 50 && (data[idx] > 128 || data[idx + 1] > 128 || data[idx + 2] > 128)) {
                        state.constraintMask[i] = 1;
                    }
                }
                console.log("Constraint mask layer loaded and rasterized successfully.");
                resolve();
            }).catch(() => {
                console.log("No pre-loaded constraint mask found (assets/taiwan_mask.png). Defenses will use custom-drawn barriers only.");
                resolve(); // Resolve anyway to proceed without mask
            });
        });
    }

    // --- Setup Canvas Overlay ---
    function setupCanvasOverlay() {
        const bounds = [
            [state.elevationBounds.south, state.elevationBounds.west],
            [state.elevationBounds.north, state.elevationBounds.east]
        ];

        // Draw initial blank overlay
        waterCtx.clearRect(0, 0, state.imgWidth, state.imgHeight);

        // L.imageOverlay can accept a canvas element directly!
        canvasOverlay = L.imageOverlay(waterCanvas, bounds, {
            opacity: 0.85,
            interactive: false,
            className: 'flooding-overlay'
        }).addTo(map);

        state.mapLoaded = true;
    }

    // Helper to map elevation to population model bracket index (0-7)
    function getBracketIndex(elevation) {
        if (elevation <= 2) return 0;
        if (elevation <= 5) return 1;
        if (elevation <= 10) return 2;
        if (elevation <= 20) return 3;
        if (elevation <= 50) return 4;
        if (elevation <= 100) return 5;
        if (elevation <= 200) return 6;
        return 7;
    }

    // --- Build Elevation Histogram & Bracket Counts ---
    function buildHistogram() {
        const pixels = state.elevationData;
        state.totalLandPixels = 0;
        state.elevationHistogram.fill(0);
        state.bracketTotalPixels.fill(0);

        // Allocate or resize defenseData array
        const totalPixels = state.imgWidth * state.imgHeight;
        if (!state.defenseData || state.defenseData.length !== totalPixels) {
            state.defenseData = new Uint8Array(totalPixels);
        }

        let under10mCount = 0;
        const oceanIndices = [];

        for (let i = 0; i < pixels.length; i += 4) {
            const b = pixels[i + 2]; // Land mask (255 if land, 0 if ocean)

            if (b === 0) {
                oceanIndices.push(i / 4);
                continue;
            }

            // Round elevation to integer for histogram indexing
            const elevation = Math.round(getElevationAtOffset(i));
            state.totalLandPixels++;

            if (elevation >= 0 && elevation < 4000) {
                state.elevationHistogram[elevation]++;
            }

            // Add to population bracket totals
            const bracketIdx = getBracketIndex(elevation);
            state.bracketTotalPixels[bracketIdx]++;

            if (elevation < 10) {
                under10mCount++;
            }

            // Count land pixels for each region based on pixel bounds
            const pixelIdx = i / 4;
            const pxX = pixelIdx % state.imgWidth;
            const pxY = Math.floor(pixelIdx / state.imgWidth);
            regions.forEach(reg => {
                if (reg.pxBounds &&
                    pxX >= reg.pxBounds.minX && pxX <= reg.pxBounds.maxX &&
                    pxY >= reg.pxBounds.minY && pxY <= reg.pxBounds.maxY) {
                    reg.totalLandPixels++;
                }
            });
        }

        // Cache ocean pixel indices for optimized BFS
        state.oceanPixelIndices = new Int32Array(oceanIndices);

        // Calculate static low-lying land stat
        const lowLyingPercent = ((under10mCount / state.totalLandPixels) * 100).toFixed(1);
        statLowLying.textContent = `~${lowLyingPercent}%`;
    }

    // --- Core Flooding Simulation Engine ---
    let animationFrameId = null;

    function updateFlooding() {
        if (!state.dataLoaded) return;

        // Use requestAnimationFrame to optimize rendering performance during slider dragging
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
        }

        animationFrameId = requestAnimationFrame(() => {
            renderFloodingCanvas();
            updateStatsAndLabels();
        });
    }

    function renderFloodingCanvas() {
        const width = state.imgWidth;
        const height = state.imgHeight;
        const pixels = state.elevationData;
        const seaLevel = getEffectiveSeaLevel();

        // Reset flooded pixels count for each region
        regions.forEach(reg => reg.floodedPixels = 0);

        const imgData = waterCtx.createImageData(width, height);
        const outData = imgData.data;

        const totalPixels = width * height;
        const flooded = new Uint8Array(totalPixels);

        // Queue for BFS Flood Fill
        const queue = new Int32Array(totalPixels);
        let head = 0;
        let tail = 0;

        // 1. Seed the queue with pre-cached ocean pixels (where b === 0)
        if (state.oceanPixelIndices) {
            const oceanPixels = state.oceanPixelIndices;
            for (let i = 0; i < oceanPixels.length; i++) {
                const pixelIdx = oceanPixels[i];
                flooded[pixelIdx] = 1;
                queue[tail++] = pixelIdx;
            }
        } else {
            // Fallback if not cached yet
            for (let i = 0; i < pixels.length; i += 4) {
                const pixelIdx = i / 4;
                const b = pixels[i + 2];
                if (b === 0) {
                    flooded[pixelIdx] = 1;
                    queue[tail++] = pixelIdx;
                }
            }
        }

        // 2. Optimized BFS Water Propagation Loop (1D Offsets)
        while (head < tail) {
            const currIdx = queue[head++];
            const currX = currIdx % width;

            // Left
            if (currX > 0) {
                const nextIdx = currIdx - 1;
                if (flooded[nextIdx] === 0) {
                    const pixelOffset = nextIdx * 4;
                    const b = pixels[pixelOffset + 2]; // Land mask (255 = land)
                    if (b === 255) {
                        const elevation = getElevationAtOffset(pixelOffset);
                        if (elevation <= seaLevel) {
                            flooded[nextIdx] = 1;
                            queue[tail++] = nextIdx;
                        }
                    }
                }
            }
            // Right
            if (currX < width - 1) {
                const nextIdx = currIdx + 1;
                if (flooded[nextIdx] === 0) {
                    const pixelOffset = nextIdx * 4;
                    const b = pixels[pixelOffset + 2];
                    if (b === 255) {
                        const elevation = getElevationAtOffset(pixelOffset);
                        if (elevation <= seaLevel) {
                            flooded[nextIdx] = 1;
                            queue[tail++] = nextIdx;
                        }
                    }
                }
            }
            // Up
            if (currIdx >= width) {
                const nextIdx = currIdx - width;
                if (flooded[nextIdx] === 0) {
                    const pixelOffset = nextIdx * 4;
                    const b = pixels[pixelOffset + 2];
                    if (b === 255) {
                        const elevation = getElevationAtOffset(pixelOffset);
                        if (elevation <= seaLevel) {
                            flooded[nextIdx] = 1;
                            queue[tail++] = nextIdx;
                        }
                    }
                }
            }
            // Down
            if (currIdx < totalPixels - width) {
                const nextIdx = currIdx + width;
                if (flooded[nextIdx] === 0) {
                    const pixelOffset = nextIdx * 4;
                    const b = pixels[pixelOffset + 2];
                    if (b === 255) {
                        const elevation = getElevationAtOffset(pixelOffset);
                        if (elevation <= seaLevel) {
                            flooded[nextIdx] = 1;
                            queue[tail++] = nextIdx;
                        }
                    }
                }
            }
        }

        // 3. Render and Count Flooded Pixels (Connected-Aware)
        let floodedLandCount = 0;
        const bracketFloodedCounts = new Int32Array(8);

        for (let idx = 0; idx < totalPixels; idx++) {
            const outOffset = idx * 4;
            const pixelOffset = idx * 4;
            const b = pixels[pixelOffset + 2];

            if (b === 0) {
                // Ocean: Keep transparent in overlay (basemap handles it)
                outData[outOffset + 3] = 0;
                continue;
            }

            if (flooded[idx] === 1) {
                const elevation = getElevationAtOffset(pixelOffset);

                // Track statistics
                floodedLandCount++;
                const bracketIdx = getBracketIndex(elevation);
                bracketFloodedCounts[bracketIdx]++;

                // Count flooded pixels for each region
                const pxX = idx % width;
                const pxY = Math.floor(idx / width);
                regions.forEach(reg => {
                    if (reg.pxBounds &&
                        pxX >= reg.pxBounds.minX && pxX <= reg.pxBounds.maxX &&
                        pxY >= reg.pxBounds.minY && pxY <= reg.pxBounds.maxY) {
                        reg.floodedPixels++;
                    }
                });

                const depth = seaLevel - elevation;

                // Color coding based on water depth
                if (depth < 5) {
                    // Shallow water (0m - 5m): Glowing cyan
                    outData[outOffset] = 0;       // R
                    outData[outOffset + 1] = 240; // G
                    outData[outOffset + 2] = 255; // B
                    outData[outOffset + 3] = 130; // A
                } else if (depth < 15) {
                    // Medium depth (5m - 15m): Light blue
                    outData[outOffset] = 0;       // R
                    outData[outOffset + 1] = 162; // G
                    outData[outOffset + 2] = 255; // B
                    outData[outOffset + 3] = 160; // A
                } else {
                    // Deep water (> 15m): Deep rich blue
                    outData[outOffset] = 0;       // R
                    outData[outOffset + 1] = 68;  // G
                    outData[outOffset + 2] = 255; // B
                    outData[outOffset + 3] = 190; // A
                }
            } else {
                // Safe land: transparent
                outData[outOffset + 3] = 0;
            }
        }

        // Save stats to state for UI updates
        state.floodedLandPixels = floodedLandCount;
        state.bracketFloodedPixels = bracketFloodedCounts;

        // Put the processed pixels back onto the overlay canvas
        waterCtx.putImageData(imgData, 0, 0);

        // Tell Leaflet to redraw the canvas overlay
        if (canvasOverlay) {
            canvasOverlay.setUrl(waterCanvas.toDataURL('image/png'));
        }
    }

    // --- Stats & Labels Updates ---
    function updateStatsAndLabels() {
        const seaLevel = state.seaLevel;

        // 1. Get Flooded Pixels directly from our connected-aware calculations
        const floodedPixels = state.floodedLandPixels;

        // 2. Calculate percentage and area
        const floodedPercent = (floodedPixels / state.totalLandPixels) * 100;
        const totalTaiwanArea = 35808; // km²
        const floodedArea = (floodedPixels / state.totalLandPixels) * totalTaiwanArea;

        // Update Stats UI with clean values
        statFloodedPercent.textContent = `${floodedPercent.toFixed(2)}%`;
        statFloodedArea.textContent = `${floodedArea.toLocaleString('zh-TW', { maximumFractionDigits: 1 })} km²`;

        // 3. Calculate Affected Population dynamically using connected-aware bracket ratios
        let totalAffectedPopulation = 0;

        populationModel.forEach((bracket, idx) => {
            const bracketTotalPixels = state.bracketTotalPixels[idx];
            const bracketFloodedPixels = state.bracketFloodedPixels[idx];

            if (bracketTotalPixels > 0) {
                const ratio = bracketFloodedPixels / bracketTotalPixels;
                totalAffectedPopulation += ratio * bracket.pop;
            }
        });

        // Render population stat
        if (totalAffectedPopulation === 0) {
            statAffectedPopulation.textContent = "0 人";
        } else if (totalAffectedPopulation > 10000) {
            statAffectedPopulation.textContent = `~ ${(totalAffectedPopulation / 10000).toFixed(1)} 萬人`;
        } else {
            statAffectedPopulation.textContent = `~ ${Math.round(totalAffectedPopulation)} 人`;
        }

        // 4. Update Region Status based on actual flooding percentage!
        regions.forEach(reg => {
            const percent = reg.totalLandPixels > 0 ? (reg.floodedPixels / reg.totalLandPixels) * 100 : 0;
            updateRegionStatus(reg.id, percent);
        });

        // 5. Update Landmark Markers
        updateLandmarks();

        // 6. Update China and World Sidebar statuses
        updateGlobalSidebarStatuses();
    }

    function updateRegionStatus(regionId, percent) {
        const el = document.getElementById(`status-${regionId}`);
        if (!el) return;

        el.className = 'region-status'; // Reset

        if (percent >= 10) {
            el.textContent = `嚴重淹水 (${percent.toFixed(1)}%)`;
            el.classList.add('status-danger');
        } else if (percent >= 1) {
            el.textContent = `警戒中 (${percent.toFixed(1)}%)`;
            el.classList.add('status-warning');
        } else if (percent > 0) {
            el.textContent = `微幅影響 (${percent.toFixed(2)}%)`;
            el.classList.add('status-warning');
        } else {
            el.textContent = '安全';
            el.classList.add('status-safe');
        }
    }

    // --- Landmark Markers Logic ---
    function createLandmarkMarker(lm, layerGroup) {
        // Create a sleek custom divIcon for each landmark
        const el = document.createElement('div');
        el.className = 'custom-city-marker';

        const pinClass = lm.type === 'user-custom' ? 'special-marker-pin' : 'marker-pin';
        const labelClass = lm.type === 'user-custom' ? 'marker-label special' : 'marker-label';

        el.innerHTML = `
            <div class="${pinClass}" id="pin-${lm.id}"></div>
            <div class="${labelClass}" id="label-${lm.id}">${lm.name} (${lm.elevation}m)</div>
        `;

        const customIcon = L.divIcon({
            html: el,
            className: 'custom-marker-wrapper',
            iconSize: [12, 12],
            iconAnchor: [6, 6]
        });

        lm.marker = L.marker([lm.lat, lm.lon], { icon: customIcon }).addTo(layerGroup);

        // Setup details popup
        lm.marker.bindPopup(`
            <div style="font-family: var(--font-body); color: #1e293b; padding: 4px;">
                <h4 style="font-family: var(--font-heading); margin-bottom: 4px; font-weight:700;">${lm.name}</h4>
                <p style="font-size:12px; margin-bottom:4px;"><strong>地標海拔:</strong> ${lm.elevation} 公尺</p>
                <p id="popup-status-${lm.id}" style="font-size:12px; font-weight:600;"></p>
            </div>
        `);

        // Hook up popupopen event
        lm.marker.on('popupopen', () => {
            const isFlooded = state.seaLevel >= lm.elevation;
            const statusEl = document.getElementById(`popup-status-${lm.id}`);
            if (statusEl) {
                if (isFlooded) {
                    statusEl.innerHTML = `<span style="color: #ef4444;">⚠️ 已淹入水中！(淹水深度: ${(state.seaLevel - lm.elevation).toFixed(1)}m)</span>`;
                } else {
                    statusEl.innerHTML = `<span style="color: #10b981;">✅ 目前安全 (高於海平面 ${(lm.elevation - state.seaLevel).toFixed(1)}m)</span>`;
                }
            }
        });
    }

    function initLandmarks() {
        landmarks.forEach(lm => createLandmarkMarker(lm, taiwanLayer));
        chinaLandmarks.forEach(lm => createLandmarkMarker(lm, chinaLayer));
        worldLandmarks.forEach(lm => createLandmarkMarker(lm, worldLayer));
    }

    function updateLandmarks() {
        const seaLevel = getEffectiveSeaLevel();

        function updateList(list) {
            list.forEach(lm => {
                const isFlooded = seaLevel >= lm.elevation;
                const pinEl = document.getElementById(`pin-${lm.id}`);
                const labelEl = document.getElementById(`label-${lm.id}`);

                if (pinEl && labelEl) {
                    if (isFlooded) {
                        pinEl.classList.add('flooded');
                        labelEl.classList.add('flooded');
                        labelEl.textContent = `${lm.name.split(' (')[0]} (已淹沒!)`;
                    } else {
                        pinEl.classList.remove('flooded');
                        labelEl.classList.remove('flooded');
                        labelEl.textContent = `${lm.name} (${lm.elevation}m)`;
                    }
                }

                // Update Popup content if open
                const popup = lm.marker.getPopup();
                if (popup && lm.marker.isPopupOpen()) {
                    const statusEl = document.getElementById(`popup-status-${lm.id}`);
                    if (statusEl) {
                        if (isFlooded) {
                            statusEl.innerHTML = `<span style="color: var(--color-danger);">⚠️ 已淹入水中！(淹水深度: ${(seaLevel - lm.elevation).toFixed(1)}m)</span>`;
                        } else {
                            statusEl.innerHTML = `<span style="color: var(--color-success);">✅ 目前安全 (高於海平面 ${(lm.elevation - seaLevel).toFixed(1)}m)</span>`;
                        }
                    }
                }
            });
        }

        updateList(landmarks);
        updateList(chinaLandmarks);
        updateList(worldLandmarks);
    }

    function updateGlobalSidebarStatuses() {
        const seaLevel = getEffectiveSeaLevel();

        // Update China provinces in the sidebar
        chinaLandmarks.forEach(lm => {
            const el = document.getElementById(`status-${lm.id}`);
            if (!el) return;

            el.className = 'region-status'; // Reset

            if (seaLevel >= lm.elevation) {
                const depth = seaLevel - lm.elevation;
                el.textContent = `已淹沒 (${depth.toFixed(1)}m)`;
                el.classList.add('status-danger');
            } else if (seaLevel >= lm.elevation - 3) {
                el.textContent = `警戒`;
                el.classList.add('status-warning');
            } else {
                el.textContent = `安全`;
                el.classList.add('status-safe');
            }
        });

        // Update World cities in the sidebar
        worldLandmarks.forEach(lm => {
            const el = document.getElementById(`status-${lm.id}`);
            if (!el) return;

            el.className = 'region-status'; // Reset

            if (seaLevel >= lm.elevation) {
                const depth = seaLevel - lm.elevation;
                el.textContent = `已淹沒 (${depth.toFixed(1)}m)`;
                el.classList.add('status-danger');
            } else if (seaLevel >= lm.elevation - 3) {
                el.textContent = `警戒`;
                el.classList.add('status-warning');
            } else {
                el.textContent = `安全`;
                el.classList.add('status-safe');
            }
        });
    }

    // --- Interactive Hover Query Panel ---
    map.on('mousemove', (e) => {
        if (!state.dataLoaded || !state.elevationBounds) return;

        const lat = e.latlng.lat;
        const lng = e.latlng.lng;

        // Update latlng display
        hoverCoords.textContent = `${lat.toFixed(4)}°N, ${lng.toFixed(4)}°E`;

        // Check if mouse is within our elevation image bounds
        const eb = state.elevationBounds;
        if (lat >= eb.south && lat <= eb.north && lng >= eb.west && lng <= eb.east) {
            // Map lat/lng to canvas pixel coordinates
            // Longitude mapping: West is 0, East is width
            const pxX = Math.floor(((lng - eb.west) / (eb.east - eb.west)) * state.imgWidth);

            // Latitude mapping: North is 0 (top), South is height (bottom)
            const pxY = Math.floor(((eb.north - lat) / (eb.north - eb.south)) * state.imgHeight);

            if (pxX >= 0 && pxX < state.imgWidth && pxY >= 0 && pxY < state.imgHeight) {
                const pixelIndex = (pxY * state.imgWidth + pxX) * 4;
                const r = state.elevationData[pixelIndex];
                const g = state.elevationData[pixelIndex + 1];
                const b = state.elevationData[pixelIndex + 2];

                if (b === 255) {
                    // It is land
                    const elevation = getElevationAtOffset(pixelIndex);
                    hoverElevation.textContent = `${elevation.toFixed(1)} 公尺 (m)`;

                    const effectiveSeaLevel = getEffectiveSeaLevel();
                    if (elevation <= effectiveSeaLevel) {
                        hoverStatus.innerHTML = `<span style="color: var(--color-danger); font-weight:600;">🌊 已淹沒 (水深 ${(effectiveSeaLevel - elevation).toFixed(1)}m)</span>`;
                    } else {
                        // Check if it's protected by a levee
                        const isLevee = state.enableDefenses && state.defenseData && state.defenseData[pixelIndex / 4] > 0;
                        if (isLevee) {
                            hoverStatus.innerHTML = `<span style="color: var(--color-success); font-weight:600;">🛡️ 堤防保護區 (堤高 ${state.defenseData[pixelIndex / 4]}m)</span>`;
                        } else {
                            hoverStatus.innerHTML = `<span style="color: var(--color-success); font-weight:600;">🛡️ 陸地安全</span>`;
                        }
                    }
                    return;
                }
            }
        }

        // Out of bounds or ocean
        hoverElevation.textContent = "海洋 (Sea)";
        hoverStatus.innerHTML = `<span style="color: var(--text-muted);">--</span>`;
    });

    // Reset hover info when mouse leaves map
    map.on('mouseout', () => {
        hoverCoords.textContent = "--";
        hoverElevation.textContent = "--";
        hoverStatus.textContent = "--";
    });

    // --- Slider & Control Event Listeners ---

    // Listen to slider changes (live dragging)
    slider.addEventListener('input', (e) => {
        state.seaLevel = parseInt(e.target.value);
        valDisplay.textContent = state.seaLevel;
        updateEffectiveSeaLevelUI();
        updateFlooding();
    });

    // Listen to Extreme Mode Toggle
    extremeToggle.addEventListener('change', (e) => {
        state.isExtremeMode = e.target.checked;

        if (state.isExtremeMode) {
            // Update slider settings for extreme heights
            slider.max = 500;
            slider.step = 5;

            // Update tick marks UI
            document.querySelector('.slider-ticks').innerHTML = `
                <span>0m</span>
                <span>100m</span>
                <span>200m</span>
                <span>300m</span>
                <span>400m</span>
                <span>500m</span>
            `;

            // Add warning style to display
            valDisplay.classList.add('text-danger');
        } else {
            // Reset to normal heights
            slider.max = 100;
            slider.step = 1;

            if (state.seaLevel > 100) {
                state.seaLevel = 100;
                slider.value = 100;
                valDisplay.textContent = 100;
            }

            // Update tick marks UI
            document.querySelector('.slider-ticks').innerHTML = `
                <span>0m</span>
                <span>20m</span>
                <span>40m</span>
                <span>60m</span>
                <span>80m</span>
                <span>100m</span>
            `;

            valDisplay.classList.remove('text-danger');
        }

        updateFlooding();
    });

    // Climate Scenario Selector Listeners
    scenarioOptions.forEach(opt => {
        opt.addEventListener('click', () => {
            scenarioOptions.forEach(o => o.classList.remove('active'));
            opt.classList.add('active');
            
            const scenario = opt.getAttribute('data-scenario');
            state.scenario = scenario;
            
            if (scenario === 'normal') {
                state.scenarioOffset = 0;
            } else if (scenario === 'spring-tide') {
                state.scenarioOffset = 1.5;
            } else if (scenario === 'storm-surge') {
                state.scenarioOffset = 3.5;
            }
            
            updateEffectiveSeaLevelUI();
            updateFlooding();
        });
    });

    // Reset Button
    btnReset.addEventListener('click', () => {
        // Stop animation if playing
        if (state.isPlaying) {
            togglePlay();
        }

        state.seaLevel = 0;
        slider.value = 0;
        valDisplay.textContent = 0;
        
        // Reset climate scenario parameters
        state.scenario = 'normal';
        state.scenarioOffset = 0;
        scenarioOptions.forEach(opt => {
            if (opt.getAttribute('data-scenario') === 'normal') {
                opt.classList.add('active');
            } else {
                opt.classList.remove('active');
            }
        });
        updateEffectiveSeaLevelUI();

        if (state.isExtremeMode) {
            extremeToggle.checked = false;
            state.isExtremeMode = false;
            slider.max = 100;
            slider.step = 1;
            valDisplay.classList.remove('text-danger');
            document.querySelector('.slider-ticks').innerHTML = `
                <span>0m</span>
                <span>20m</span>
                <span>40m</span>
                <span>60m</span>
                <span>80m</span>
                <span>100m</span>
            `;
        }

        // --- Reset Defenses and Calibration ---
        state.enableDefenses = false;
        if (enableDefensesToggle) enableDefensesToggle.checked = false;
        if (defenseDrawControls) defenseDrawControls.style.display = 'none';
        
        state.leveeHeight = 6;
        if (leveeHeightSlider) leveeHeightSlider.value = 6;
        if (leveeHeightVal) leveeHeightVal.textContent = 6;
        
        clearAllLevees(); // Clears polylines and fills defenseData with 0

        state.scaleFactor = 1.0;
        if (scaleFactorSlider) scaleFactorSlider.value = 1.0;
        if (scaleFactorVal) scaleFactorVal.textContent = "1.00";

        state.offsetCorrection = 0.0;
        if (offsetCorrectionSlider) offsetCorrectionSlider.value = 0.0;
        if (offsetCorrectionVal) offsetCorrectionVal.textContent = "0.0";

        // Reset decoding mode
        state.decodingMode = 'normalized';
        if (decodingModeSelect) decodingModeSelect.value = 'normalized';

        // Re-build histogram since calibration changed back to default
        buildHistogram();
        updateFlooding();
    });

    // Tab Switcher Event Listeners
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const tabId = btn.getAttribute('data-tab');

            // Deactivate all tabs
            tabBtns.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));

            // Activate clicked tab
            btn.classList.add('active');
            document.getElementById(`tab-${tabId}`).classList.add('active');
        });
    });

    // Play / Pause Animation Button
    btnPlay.addEventListener('click', togglePlay);

    function togglePlay() {
        state.isPlaying = !state.isPlaying;

        if (state.isPlaying) {
            // Change button state
            btnPlay.classList.add('btn-secondary');
            btnPlay.classList.remove('btn-primary');
            btnPlay.innerHTML = `<i data-lucide="pause" class="btn-icon"></i> <span id="play-text">暫停播放</span>`;
            lucide.createIcons();

            // If at max, reset first
            const maxVal = parseInt(slider.max);
            if (state.seaLevel >= maxVal) {
                state.seaLevel = 0;
                slider.value = 0;
                valDisplay.textContent = 0;
                updateEffectiveSeaLevelUI();
                updateFlooding();
            }

            // Start animation loop
            const step = state.isExtremeMode ? 5 : 1;
            state.animationInterval = setInterval(() => {
                const currentMax = parseInt(slider.max);
                if (state.seaLevel < currentMax) {
                    state.seaLevel += step;
                    slider.value = state.seaLevel;
                    valDisplay.textContent = state.seaLevel;
                    updateEffectiveSeaLevelUI();
                    updateFlooding();
                } else {
                    // Loop or stop
                    togglePlay();
                }
            }, 120); // Smooth increments every 120ms
        } else {
            // Pause
            btnPlay.classList.add('btn-primary');
            btnPlay.classList.remove('btn-secondary');
            btnPlay.innerHTML = `<i data-lucide="play" class="btn-icon"></i> <span id="play-text">自動播放</span>`;
            lucide.createIcons();

            clearInterval(state.animationInterval);
            state.animationInterval = null;
        }
    }

    // ==========================================================================
    // Flood Defense (Levee Drawing & Rasterization) & Terrain Calibration Logic
    // ==========================================================================

    // 1. Enable/Disable Defenses Toggle
    enableDefensesToggle.addEventListener('change', (e) => {
        state.enableDefenses = e.target.checked;
        if (state.enableDefenses) {
            defenseDrawControls.style.display = 'block';
        } else {
            defenseDrawControls.style.display = 'none';
            if (state.isDrawingLevee) {
                toggleLeveeDrawing();
            }
        }
        updateFlooding();
    });

    // 2. Levee Height Slider
    leveeHeightSlider.addEventListener('input', (e) => {
        state.leveeHeight = parseInt(e.target.value);
        leveeHeightVal.textContent = state.leveeHeight;
        
        // If we have active barriers, re-rasterize them with the new height
        if (state.leveeCoordsList.length > 0) {
            rasterizeLevees();
            updateFlooding();
        }
    });

    // 3. Interactive Levee Drawing Engine
    let activePoints = [];
    let activePolyline = null;
    let activeGuideline = null;

    function toggleLeveeDrawing() {
        state.isDrawingLevee = !state.isDrawingLevee;
        const mapEl = document.getElementById('map');

        if (state.isDrawingLevee) {
            btnDrawLevee.classList.add('btn-drawing-active');
            btnDrawLevee.innerHTML = `<i data-lucide="square" class="btn-icon"></i> <span>結束繪製</span>`;
            mapEl.classList.add('drawing-active');

            // Disable standard Leaflet drag-pan and double-click zoom to make drawing fluid
            map.dragging.disable();
            map.doubleClickZoom.disable();

            activePoints = [];
            activePolyline = L.polyline([], {
                color: '#f59e0b',
                weight: 4,
                dashArray: '5, 5'
            }).addTo(map);

            activeGuideline = L.polyline([], {
                color: '#f59e0b',
                weight: 2,
                opacity: 0.5,
                dashArray: '3, 3'
            }).addTo(map);

            // Hook drawing events
            map.on('click', onMapClick);
            map.on('mousemove', onMapMouseMove);
            document.addEventListener('keydown', onEscKey);
        } else {
            btnDrawLevee.classList.remove('btn-drawing-active');
            btnDrawLevee.innerHTML = `<i data-lucide="pencil" class="btn-icon"></i> <span>繪製防洪堤</span>`;
            mapEl.classList.remove('drawing-active');

            // Re-enable standard Leaflet behaviors
            map.dragging.enable();
            map.doubleClickZoom.enable();

            // Clear drawing layers
            if (activePolyline) {
                map.removeLayer(activePolyline);
                activePolyline = null;
            }
            if (activeGuideline) {
                map.removeLayer(activeGuideline);
                activeGuideline = null;
            }

            // Unhook drawing events
            map.off('click', onMapClick);
            map.off('mousemove', onMapMouseMove);
            document.removeEventListener('keydown', onEscKey);

            // Save the drawn polyline if it has at least 2 points
            if (activePoints.length >= 2) {
                saveActiveLevee();
            }
        }
        lucide.createIcons();
    }

    function onMapClick(e) {
        activePoints.push(e.latlng);
        activePolyline.setLatLngs(activePoints);
    }

    function onMapMouseMove(e) {
        if (activePoints.length > 0 && activeGuideline) {
            activeGuideline.setLatLngs([activePoints[activePoints.length - 1], e.latlng]);
        }
    }

    function onEscKey(e) {
        if (e.key === 'Escape') {
            toggleLeveeDrawing();
        }
    }

    function saveActiveLevee() {
        // Create permanent visual representation on the map
        const permanentPoly = L.polyline(activePoints, {
            color: '#f59e0b',
            weight: 5,
            opacity: 0.9
        }).addTo(map);

        permanentPoly.bindPopup(`
            <div style="font-family: var(--font-body); color: #1e293b; padding: 4px; font-size:12px;">
                <strong style="font-family: var(--font-heading); font-size:13px; color:#f59e0b;">🛡️ 人工防洪堤防</strong>
                <p style="margin-top:4px;"><strong>設計高度:</strong> ${state.leveeHeight} 公尺 (m)</p>
            </div>
        `);

        state.leveePolylines.push(permanentPoly);

        // Record coordinates
        state.leveeCoordsList.push(activePoints.map(p => ({ lat: p.lat, lng: p.lng })));

        // Rasterize coordinates onto our defense heights mask
        rasterizeLevees();
        updateFlooding();
    }

    function rasterizeLevees() {
        if (!state.defenseData) return;

        // Reset defense data grid
        state.defenseData.fill(0);

        if (state.leveeCoordsList.length === 0) return;

        // Create temporary offscreen canvas of matching size to draw the vectors
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = state.imgWidth;
        tempCanvas.height = state.imgHeight;
        const tempCtx = tempCanvas.getContext('2d');

        tempCtx.strokeStyle = 'white';
        tempCtx.lineWidth = 3; // thickness of levee line in pixels
        tempCtx.lineCap = 'round';
        tempCtx.lineJoin = 'round';

        state.leveeCoordsList.forEach(coords => {
            if (coords.length < 2) return;

            tempCtx.beginPath();
            const eb = state.elevationBounds;

            const startX = ((coords[0].lng - eb.west) / (eb.east - eb.west)) * state.imgWidth;
            const startY = ((eb.north - coords[0].lat) / (eb.north - eb.south)) * state.imgHeight;
            tempCtx.moveTo(startX, startY);

            for (let i = 1; i < coords.length; i++) {
                const x = ((coords[i].lng - eb.west) / (eb.east - eb.west)) * state.imgWidth;
                const y = ((eb.north - coords[i].lat) / (eb.north - eb.south)) * state.imgHeight;
                tempCtx.lineTo(x, y);
            }
            tempCtx.stroke();
        });

        // Read the canvas pixels
        const imgData = tempCtx.getImageData(0, 0, state.imgWidth, state.imgHeight);
        const data = imgData.data;

        // Map white canvas pixels to levee height in state.defenseData
        for (let idx = 0; idx < state.imgWidth * state.imgHeight; idx++) {
            if (data[idx * 4] > 0) { // Painted white
                state.defenseData[idx] = state.leveeHeight;
            }
        }
    }

    function clearAllLevees() {
        // Remove layers from map
        state.leveePolylines.forEach(poly => map.removeLayer(poly));
        state.leveePolylines = [];
        state.leveeCoordsList = [];

        if (state.defenseData) {
            state.defenseData.fill(0);
        }

        updateFlooding();
    }

    btnDrawLevee.addEventListener('click', toggleLeveeDrawing);
    btnClearLevees.addEventListener('click', clearAllLevees);

    // 4. Advanced Terrain Calibration Sliders
    scaleFactorSlider.addEventListener('input', (e) => {
        state.scaleFactor = parseFloat(e.target.value);
        scaleFactorVal.textContent = state.scaleFactor.toFixed(2);
    });

    scaleFactorSlider.addEventListener('change', () => {
        // Recalculate histogram and flood extent on value change
        buildHistogram();
        updateFlooding();
    });

    offsetCorrectionSlider.addEventListener('input', (e) => {
        state.offsetCorrection = parseFloat(e.target.value);
        offsetCorrectionVal.textContent = state.offsetCorrection.toFixed(1);
    });

    offsetCorrectionSlider.addEventListener('change', () => {
        buildHistogram();
        updateFlooding();
    });

    // 5. Decoding Mode Selector
    decodingModeSelect.addEventListener('change', (e) => {
        state.decodingMode = e.target.value;
        buildHistogram();
        updateFlooding();
    });

    // 6. Mobile Bottom Sheet Event Listeners
    const sidebar = document.querySelector('.sidebar');
    const sidebarHandle = document.querySelector('.sidebar-handle');

    if (sidebarHandle && sidebar) {
        sidebarHandle.addEventListener('click', (e) => {
            sidebar.classList.toggle('collapsed');
            e.stopPropagation();
        });

        // Also allow clicking the header to expand if it is collapsed (improves mobile tap target area)
        const sidebarHeader = document.querySelector('.sidebar-header');
        if (sidebarHeader) {
            sidebarHeader.addEventListener('click', (e) => {
                if (sidebar.classList.contains('collapsed')) {
                    sidebar.classList.remove('collapsed');
                    e.stopPropagation();
                }
            });
        }

        // Prevent touch propagation on the sidebar to avoid dragging/moving the Leaflet map in the background
        const stopTouchPropagation = (e) => {
            e.stopPropagation();
        };

        sidebar.addEventListener('touchstart', stopTouchPropagation, { passive: true });
        sidebar.addEventListener('touchmove', stopTouchPropagation, { passive: true });
        sidebar.addEventListener('touchend', stopTouchPropagation, { passive: true });
    }
});
