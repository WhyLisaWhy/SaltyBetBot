// WAIFU4u: Bets are OPEN for FOO vs BAR! (B Tier) (matchmaking) www.saltybet.com
// WAIFU4u: Bets are locked. FOO (6) - $515,396, BAR (1) - $896,035
// WAIFU4u: FOO wins! Payouts to Team Red. 77 more matches until the next tournament!

// WAIFU4u: Bets are OPEN for FOO vs BAR! (B Tier) tournament bracket: http://www.saltybet.com/shaker?bracket=1
// WAIFU4u: Bets are locked. FOO (-5) - $141,061, BAR (3) - $638,656
// WAIFU4u: BAR wins! Payouts to Team Blue. 13 characters are left in the bracket!

// SaltyBet: Tournament will start shortly. Thanks for watching!  wtfSALTY
// WAIFU4u: BAR wins! Payouts to Team Blue. 16 characters are left in the bracket!

// SaltyBet: Exhibitions will start shortly. Thanks for watching!  wtfSALTY
// SaltyBet: wtfSalt Congrats tournament winner! stuker (+$1,219,553)
// WAIFU4u: BAR wins! Payouts to Team Blue. 25 exhibition matches left!

// WAIFU4u: Bets are OPEN for FOO vs BAR! (Requested by WormPHD) (exhibitions) www.saltybet.com
// WAIFU4u: Bets are OPEN for FOO vs BAR! (X / X Tier) (Requested by Yeno) (exhibitions) www.saltybet.com
// WAIFU4u: Bets are locked. FOO- $723,823, BAR- $60,903
// WAIFU4u: FOO wins! Payouts to Team Red. 24 exhibition matches left!

// Bets are OPEN for Team DoraTheEmployer vs Team NoSwiping! (Requested by NinaYamada) (exhibitions) www.saltybet.com

// WAIFU4u: "wtfSalt ♫ "

use std::iter::Iterator;
use discard::DiscardOnDrop;
use salty_bet_bot::{parse_f64, wait_until_defined, get_text_content, query, query_all, regexp, server_log, log, spawn, NodeListIter, DOCUMENT, MutationObserver};
use salty_bet_bot::api::{WaifuMessage, WaifuBetsOpen, WaifuBetsClosed, WaifuBetsClosedInfo, WaifuWinner};
use algorithm::record::{Tier, Mode, Winner};
use js_sys::Date;
use web_sys::{Node, Element, HtmlImageElement, MutationRecord, MutationObserverInit};
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;


fn parse_tier(input: &Option<String>) -> Option<Tier> {
    match input.as_deref() {
        // TODO is this correct ?
        None => Some(Tier::None),
        Some("NEW") => Some(Tier::New),
        Some("None") => Some(Tier::None),
        Some("X") => Some(Tier::X),
        Some("S") => Some(Tier::S),
        Some("A") => Some(Tier::A),
        Some("B") => Some(Tier::B),
        Some("P") => Some(Tier::P),
        _ => None,
    }
}

fn parse_mode(input: &str) -> Option<Mode> {
    match input {
        "(matchmaking) www.saltybet.com" => Some(Mode::Matchmaking),
        "tournament bracket: http://www.saltybet.com/shaker?bracket=1" => Some(Mode::Tournament),
        "tournament bracket: https://www.saltybet.com/shaker?bracket=1" => Some(Mode::Tournament),
        "(exhibitions) www.saltybet.com" => Some(Mode::Exhibitions),
        _ => None,
    }
}

fn parse_bets_open(input: &str, date: f64) -> Option<WaifuMessage> {
    thread_local! {
        static BET_OPEN_REGEX: regexp::RegExp = regexp::RegExp::new(
            r"^Bets are OPEN for (.+) vs (.+?) *!(?: \((NEW|None|[XSABP])(?: / (?:NEW|None|[XSABP]))? Tier\))? (?:\(Requested by .+? *\) )?((?:\(matchmaking\) www\.saltybet\.com)|(?:tournament bracket: https?://www\.saltybet\.com/shaker\?bracket=1)|(?:\(exhibitions\) www\.saltybet\.com))$"
        );
    }

    BET_OPEN_REGEX.with(|re| re.first_match(input)).and_then(|mut captures|
        captures[1].take().and_then(|left|
        captures[2].take().and_then(|right|
        parse_tier(&captures[3]).and_then(|tier|
        captures[4].as_ref().and_then(|x| parse_mode(x)).map(|mode|
            WaifuMessage::BetsOpen(WaifuBetsOpen { left, right, tier, mode, date }))))))
}


fn parse_bets_closed(input: &str, date: f64) -> Option<WaifuMessage> {
    thread_local! {
        static BETS_CLOSED_REGEX: regexp::RegExp = regexp::RegExp::new(
            r"^Bets are locked\. (.+?)(?: \((-?[0-9,]+)\))? *- \$([0-9,]+), (.+?)(?: \((-?[0-9,]+)\))? *- \$([0-9,]+)$"
        );
    }

    /*let capture = BETS_CLOSED_REGEX.captures(input)?;
    let left_name        = capture.get(1)?;
    let left_win_streak  = capture.get(2)?;
    let left_bet_amount  = capture.get(3)?;
    let right_name       = capture.get(4)?;
    let right_win_streak = capture.get(5)?;
    let right_bet_amount = capture.get(6)?;

    Some(WaifuMessage::BetsClosed(WaifuBetsClosed {
        left: WaifuBetsClosedInfo {
            name: to_string(left_name),
            win_streak: parse_f64(left_win_streak.as_str()),
            bet_amount: parse_f64(left_bet_amount.as_str()),
        },
        right: WaifuBetsClosedInfo {
            name: to_string(right_name),
            win_streak: parse_f64(right_win_streak.as_str()),
            bet_amount: parse_f64(right_bet_amount.as_str()),
        },
        date: date
    }))*/

    let mut captures = BETS_CLOSED_REGEX.with(|re| re.first_match(input))?;
    let left_name = captures[1].take()?;
    let left_win_streak = captures[2].as_ref().and_then(|x| parse_f64(x)).unwrap_or(0.0);
    let left_bet_amount = captures[3].as_ref().and_then(|x| parse_f64(x))?;
    let right_name = captures[4].take()?;
    let right_win_streak = captures[5].as_ref().and_then(|x| parse_f64(x)).unwrap_or(0.0);
    let right_bet_amount = captures[6].as_ref().and_then(|x| parse_f64(x))?;

    Some(WaifuMessage::BetsClosed(WaifuBetsClosed {
        left: WaifuBetsClosedInfo { name: left_name, win_streak: left_win_streak, bet_amount: left_bet_amount },
        right: WaifuBetsClosedInfo { name: right_name, win_streak: right_win_streak, bet_amount: right_bet_amount },
        date,
    }))
}


fn parse_side(input: &str) -> Option<Winner> {
    match input {
        "Red" => Some(Winner::Left),
        "Blue" => Some(Winner::Right),
        _ => None,
    }
}

fn parse_winner(input: &str, date: f64) -> Option<WaifuMessage> {
    thread_local! {
        static WINNER_REGEX: regexp::RegExp = regexp::RegExp::new(
            r"^(.+) wins! Payouts to Team (Red|Blue)\.(?: |$)"
        );
    }

    WINNER_REGEX.with(|re| re.first_match(input)).and_then(|mut captures|
        captures[1].take().and_then(|name|
        captures[2].as_ref().and_then(|x| parse_side(x)).map(|side|
            WaifuMessage::Winner(WaifuWinner { name, side, date }))))
}


fn parse_mode_switch(input: &str, date: f64) -> Option<WaifuMessage> {
    thread_local! {
        static MODE_SWITCH_REGEX: regexp::RegExp = regexp::RegExp::new(
            r"^(Tournament|Exhibitions|Matchmaking) will start shortly\. Thanks for watching! wtfSALTY$"
        );
    }

    MODE_SWITCH_REGEX.with(|re| re.first_match(input)).and_then(|mut captures|
        captures[1].take().map(|mode| {
            let is_exhibition = mode == "Exhibitions";
            WaifuMessage::ModeSwitch { date, is_exhibition }
        }))
}


fn check_unknown_message(input: &str) -> Option<WaifuMessage> {
    thread_local! {
        static UNKNOWN_REGEX: regexp::RegExp = regexp::RegExp::new(
            r"(?:^wtfSalt ♫ )|(?:^(?:NEW|None|[XSABP])(?: / (?:NEW|None|[XSABP]))? Tier$)|(?:^Current stage: )|(?:^(?:.+) by(?: .+?)? *, (?:.+) by(?: .+)?$)|(?:^Current odds: [0-9\.]+:[0-9\.]+$)|(?:^The current game mode is: (?:matchmaking|tournament|exhibitions)\. [0-9]+ (?:more matches until the next tournament|characters are left in the bracket|exhibition matches left)!$)|(?:^Download WAIFU Wars at www\.waifuwars\.com! https://clips\.twitch\.tv/UninterestedHumbleCiderWoofer)|(?:^Current pot total: \$[0-9]+$)|(?:^The current tournament bracket can be found at: http://www\.saltybet\.com/shaker\?bracket=1$)|(?:^wtfVeku Note: .*\(from (?:.*?) *\)$)|(?:^wtfSALTY (?:.+) is fighting to stay in [SAB] Tier!$)|(?:^wtfSALTY New Waifu Wars bounties available! Winner: (?:.+) \(wave [0-9,]+\)! Play for free at http://www\.waifuwars\.com$)|(?:^wtfSalt Congrats tournament winner! (?:.+) \(\+\$[0-9,]+\)$)|(?:^The current game mode is: (?:tournament|exhibitions)\. FINAL ROUND! Stay tuned for exhibitions after the tournament!$)|(?:^Bets are locked\. (?:.+?) *- \$[0-9,]+, (?:.+?) *- \$[0-9,]+$)|(?:^(?:.+) vs (?:.+) was requested by (?:.+?) *\. OMGScoots$)|(?:^Palettes of previous match: [0-9]+(?: / [0-9]+)?, [0-9]+(?: / [0-9]+)?$)|(?:^The current game mode is: (?:matchmaking|exhibitions)\. Matchmaking mode will be activated after the next exhibition match!$)|(?:^The current game mode is: tournament\. Tournament mode will be activated after the next match!$)|(?:^wtfSALTY (?:.+) has been demoted!$)|(?:^(?:.+) vs (?:.+) was requested by RNG\. Kappa$)|(?:^The current game mode is: matchmaking\. Tournament mode will be activated after the next match!$)|(?:^wtfSALTY (?:.+) is fighting for a promotion from [ABP] to [SAB] Tier!$)|(?:^wtfSALTY (?:.+) has been promoted!$)|(?:^[0-9,]+ characters are left in NEW tier: http://www\.saltybet\.com/stats\?playerstats=1&new=1$)|(?:^Join the official Salty Bet Illuminati Discord! https://discord\.gg/saltybet$)|(?:^https://www\.waifuwars\.com$)"
        );
    }

    if !UNKNOWN_REGEX.with(|re| re.is_match(input)) {
        server_log!("Unknown message: {:#?}", input);
    }

    None
}

fn parse_message(input: &str, date: f64) -> Option<WaifuMessage> {
    thread_local! {
        static NAME_REGEX: regexp::RegExp = regexp::RegExp::new(r"^([^:]+): *(.*)$");
    }

    NAME_REGEX.with(|re| re.first_match(input)).and_then(|captures|
        captures[1].as_ref().and_then(|name| {
            if name == "WAIFU4u" || name == "SaltyBet" {
                captures[2].as_ref().and_then(|message| {
                    parse_bets_open(message, date).or_else(||
                    parse_bets_closed(message, date).or_else(||
                    parse_winner(message, date).or_else(||
                    parse_mode_switch(message, date).or_else(||
                    check_unknown_message(message)))))
                })

            } else {
                None
            }
        }))
}


fn remove_nodes(node: &Element, selector: &str) {
    for node in NodeListIter::new(node.query_selector_all(selector).unwrap()) {
        node.parent_node()
            .unwrap()
            .remove_child(&node)
            .unwrap();
    }
}

fn get_waifu_message(node: Node, date: f64) -> Option<WaifuMessage> {
    // This is to avoid mutating the DOM of the chat
    let node = node.clone_node_with_deep(true).unwrap();

    let node: Element = node.dyn_into().unwrap();

    // This removes the timestamps
    remove_nodes(&node, ".chat-line__timestamp");

    // This removes the Twitch badges
    remove_nodes(&node, "img.chat-badge");

    // Hack to replace emotes with their text version, needed because sometimes fighters have emotes in their name
    // TODO can this be made better somehow ?
    for node in NodeListIter::new(node.query_selector_all("img").unwrap()) {
        let node: HtmlImageElement = node.dyn_into().unwrap();

        node.parent_node()
            .unwrap()
            .replace_child(&DOCUMENT.with(|document| document.create_text_node(&node.alt())), &node)
            .unwrap();
    }

    get_text_content(&node).and_then(|x| parse_message(&x, date))
}


pub fn get_waifu_messages() -> Vec<WaifuMessage> {
    let now: f64 = Date::now();

    NodeListIter::new(query_all("[data-a-target='chat-line-message']"))
        .filter_map(|x| get_waifu_message(x, now))
        .collect()
}

fn get_added_waifu_messages(node: Node, date: f64) -> Vec<WaifuMessage> {
    let element = match node.dyn_into::<Element>() {
        Ok(element) => element,
        Err(_) => return vec![],
    };
    let mut messages = vec![];
    if element.get_attribute("data-a-target").as_deref() == Some("chat-line-message") {
        if let Some(message) = get_waifu_message(element.clone().into(), date) {
            messages.push(message);
        }
    }
    messages.extend(
        NodeListIter::new(element.query_selector_all("[data-a-target='chat-line-message']").unwrap())
            .filter_map(|node| get_waifu_message(node, date)),
    );
    messages
}


#[wasm_bindgen(start)]
pub fn main_js() {
    console_error_panic_hook::set_once();


    log!("Initializing...");

    let observer = {
        MutationObserver::new(move |records: Vec<MutationRecord>| {
            let now: f64 = Date::now();

            let messages: Vec<WaifuMessage> = records.into_iter().flat_map(|record| {
                assert_eq!(record.type_().as_str(), "childList");
                NodeListIter::new(record.added_nodes())
                    .flat_map(|node| get_added_waifu_messages(node, now))
            }).collect();

            if !messages.is_empty() {
                spawn(salty_bet_bot::api::twitch_events_send(messages));
            }
        })
    };

    /*wait_until_defined(|| query("body"), move |body| {
        js! { @(no_return)
            @{body}.style.display = "none";
        }

        log!("Body hidden");
    });*/

    wait_until_defined(|| {
        query("[data-a-target='chat-scrollable-area__message-container']")
            .or_else(|| query("[data-a-target='chat-welcome-message']").and_then(|node| node.parent_element()))
    }, move |container| {
        let options = MutationObserverInit::new();
        options.set_child_list(true);
        options.set_subtree(true);
        observer.observe(&container, &options);

        DiscardOnDrop::leak(observer);
        spawn(salty_bet_bot::api::twitch_events_send(get_waifu_messages()));
        log!("Observer initialized and existing messages processed");
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasm_bindgen_test::*;

    wasm_bindgen_test_configure!(run_in_browser);

    #[wasm_bindgen_test]
    fn parses_current_match_messages() {
        assert!(matches!(
            parse_message("WAIFU4u: Bets are OPEN for Alpha vs Beta! (A / B Tier) (matchmaking) www.saltybet.com", 1.0),
            Some(WaifuMessage::BetsOpen(_)),
        ));
        assert!(matches!(
            parse_message("WAIFU4u: Bets are locked. Alpha- $723,823, Beta- $60,903", 2.0),
            Some(WaifuMessage::BetsClosed(_)),
        ));
        assert!(matches!(
            parse_message("WAIFU4u: Alpha wins! Payouts to Team Red.", 3.0),
            Some(WaifuMessage::Winner(_)),
        ));
        assert!(matches!(
            parse_message("WAIFU4u: Exhibitions will start shortly. Thanks for watching! wtfSALTY", 4.0),
            Some(WaifuMessage::ModeSwitch { .. }),
        ));
    }
}
